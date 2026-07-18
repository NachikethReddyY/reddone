import { createHash } from "node:crypto";

import { ResearchPacketSchema } from "@/contracts";
import { getDb } from "@/server/db";
import { isDemoMode } from "@/server/env";
import { storeAuthorizedImport } from "@/server/project-repository";
import {
  claimPublishedIdempotencyReceipt,
  completePublishedIdempotencyReceipt,
  secureIdempotencyFingerprint,
} from "@/server/published-idempotency";
import { getProject, readIdempotent, writeIdempotent } from "@/workflows/demo-store";
import { handleRouteError, HttpError, mutationContext, ok, requestId } from "@/workflows/http";

type Context = { params: Promise<{ projectId: string }> };

export async function POST(request: Request, { params }: Context) {
  const id = requestId(request);
  try {
    const context = await mutationContext(request, { requireVersion: true });
    const { projectId } = await params;
    const raw = await request.text();
    if (Buffer.byteLength(raw) > 10_000_000) throw new HttpError("bad_request", "Import exceeds 10 MB.", 413);
    const packet = ResearchPacketSchema.parse(JSON.parse(raw));
    if (!isDemoMode()) {
      const operation = "research.import.create";
      const contentHash = createHash("sha256").update(raw).digest("hex");
      const requestFingerprint = secureIdempotencyFingerprint(operation, {
        projectId,
        contentHash,
        expectedProjectVersion: context.expectedVersion,
      });
      const claim = await claimPublishedIdempotencyReceipt({
        workspaceId: context.owner.workspaceId,
        idempotencyKey: context.idempotencyKey,
        operation,
        requestFingerprint,
      });
      if (claim.kind === "replay") {
        if (!claim.outcome.ok) {
          throw new HttpError(claim.outcome.error.code, claim.outcome.error.message, claim.outcome.error.status, claim.outcome.error.retryable);
        }
        return ok(claim.outcome.response, context.requestId);
      }
      if (claim.kind === "in_progress") throw new HttpError("conflict", "This import request is already in progress.", 409, true);
      const imported = await storeAuthorizedImport({
        workspaceId: context.owner.workspaceId,
        projectId,
        packet,
        raw: Buffer.from(raw, "utf8"),
        expectedProjectVersion: context.expectedVersion!,
        allowRecoveredImport: claim.claim.fencingVersion > 1,
      });
      const result = {
        importId: imported.id,
        projectId,
        contentHash: imported.contentHash,
        documentCount: imported.documentCount,
        byteSize: imported.byteSize,
        acceptedAt: imported.acceptedAt?.toISOString(),
        projectOptimisticVersion: (await getDb().project.findUniqueOrThrow({
          where: { workspaceId_id: { workspaceId: context.owner.workspaceId, id: projectId } },
          select: { optimisticVersion: true },
        })).optimisticVersion,
      };
      await completePublishedIdempotencyReceipt({
        workspaceId: context.owner.workspaceId,
        claim: claim.claim,
        operation,
        requestFingerprint,
        outcome: { ok: true, response: result },
        audit: {
          actorUserId: context.owner.userId,
          action: "research.import.accepted",
          targetType: "research_import",
          targetId: imported.id,
          requestId: context.requestId,
          metadata: { projectId, contentHash: imported.contentHash, documentCount: imported.documentCount },
        },
      });
      return ok(result, context.requestId, { status: 201 });
    }
    const cached = readIdempotent<unknown>(context.idempotencyKey);
    if (cached) return ok(cached, context.requestId);
    const project = getProject(projectId);
    if (!project) throw new HttpError("not_found", "Project not found.", 404);
    if (project.version !== context.expectedVersion) throw new HttpError("precondition_failed", "Project version conflict.", 412);
    const receipt = {
      importId: `import_${createHash("sha256").update(raw).digest("hex").slice(0, 24)}`,
      projectId,
      contentHash: createHash("sha256").update(raw).digest("hex"),
      documentCount: packet.documents.length,
      byteSize: Buffer.byteLength(raw),
      acceptedAt: new Date().toISOString(),
      sourceLabel: packet.sourceLabel,
      retainedContent: false,
      projectOptimisticVersion: project.version + 1,
    };
    project.sourceMode = "import";
    project.sourceLabel = `Authorized import · ${packet.documents.length} documents`;
    project.blocker = null;
    project.nextAction = "Start research on the validated import";
    project.version += 1;
    project.updatedAt = receipt.acceptedAt;
    writeIdempotent(context.idempotencyKey, receipt);
    return ok(receipt, context.requestId, { status: 201 });
  } catch (error) {
    return handleRouteError(error, id);
  }
}
