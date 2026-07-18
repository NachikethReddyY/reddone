import { createHash } from "node:crypto";

import { canonicalJson } from "@/server/security/canonical-json";
import { getDb } from "@/server/db";
import { recordAuditEvent } from "@/server/audit";
import { isDemoMode } from "@/server/env";
import { handleRouteError, HttpError, mutationContext, ok, requestId } from "@/workflows/http";

type Context = { params: Promise<{ projectId: string; secretVersionId: string }> };

export async function DELETE(request: Request, { params }: Context) {
  const id = requestId(request);
  try {
    const context = await mutationContext(request, { requireVersion: true });
    if (isDemoMode()) throw new HttpError("feature_disabled", "Demo mode stores no project secret to revoke.", 403);
    const { projectId, secretVersionId } = await params;
    const db = getDb();
    const existing = await db.outboxEvent.findUnique({
      where: { workspaceId_idempotencyKey: { workspaceId: context.owner.workspaceId, idempotencyKey: context.idempotencyKey } },
    });
    if (existing) {
      if (existing.eventType !== "project.secret.revoked") throw new HttpError("conflict", "The idempotency key belongs to another mutation.", 409);
      return ok(existing.payload, context.requestId);
    }
    const result = await db.$transaction(async (tx) => {
      const project = await tx.project.findUnique({ where: { workspaceId_id: { workspaceId: context.owner.workspaceId, id: projectId } } });
      if (!project) throw new HttpError("not_found", "Project not found.", 404);
      if (project.optimisticVersion !== context.expectedVersion) throw new HttpError("precondition_failed", "Project version conflict.", 412);
      const secret = await tx.secretVersion.findFirst({
        where: { id: secretVersionId, workspaceId: context.owner.workspaceId, projectId, scope: "PROJECT_RUNTIME" },
      });
      if (!secret) throw new HttpError("not_found", "Project secret version not found.", 404);
      const priorRevocation = await tx.outboxEvent.findFirst({
        where: { workspaceId: context.owner.workspaceId, aggregateType: "secret_version", aggregateId: secret.id, eventType: "project.secret.revoked" },
      });
      if (priorRevocation) return priorRevocation.payload as { projectId: string; secretVersionId: string; name: string; version: number; revokedAt: string };
      const now = new Date();
      if (!secret.revokedAt) await tx.secretVersion.update({ where: { id: secret.id }, data: { revokedAt: now } });
      const grants = await tx.projectSecretGrant.findMany({
        where: { workspaceId: context.owner.workspaceId, projectId, secretVersionId: secret.id, status: { in: ["PENDING", "ACTIVE"] } },
        select: { id: true, approvalId: true },
      });
      if (grants.length) {
        await tx.projectSecretGrant.updateMany({
          where: { id: { in: grants.map((grant) => grant.id) } },
          data: { status: "REVOKED", revokedAt: now },
        });
        await tx.approval.updateMany({
          where: { id: { in: grants.map((grant) => grant.approvalId) }, status: "PENDING" },
          data: { status: "SUPERSEDED", optimisticVersion: { increment: 1 } },
        });
      }
      await tx.project.update({
        where: { id: projectId },
        data: { optimisticVersion: { increment: 1 }, currentBlocker: "Review release approvals after project secret revocation" },
      });
      const payload = { projectId, secretVersionId: secret.id, name: secret.name, version: secret.version, revokedAt: (secret.revokedAt ?? now).toISOString() };
      await tx.outboxEvent.create({
        data: {
          workspaceId: context.owner.workspaceId,
          aggregateType: "secret_version",
          aggregateId: secret.id,
          aggregateVersion: secret.version + 1,
          eventType: "project.secret.revoked",
          payload,
          payloadHash: createHash("sha256").update(canonicalJson(payload)).digest("hex"),
          idempotencyKey: context.idempotencyKey,
          publishedAt: now,
        },
      });
      return payload;
    }, { isolationLevel: "Serializable", timeout: 15_000 });
    await recordAuditEvent({
      workspaceId: context.owner.workspaceId,
      actorUserId: context.owner.userId,
      action: "project.secret.revoked",
      targetType: "secret_version",
      targetId: secretVersionId,
      requestId: context.requestId,
      metadata: { projectId, name: result.name, version: result.version },
    });
    return ok(result, context.requestId);
  } catch (error) {
    return handleRouteError(error, id);
  }
}
