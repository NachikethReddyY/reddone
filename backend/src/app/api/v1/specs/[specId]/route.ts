import { createHash } from "node:crypto";

import { z } from "zod";

import { ProductSpecPatchInputSchema, ProjectConfigSchema, type ApprovalPayload } from "@/contracts";
import { getBackendBuildProviderAccounts } from "@/server/backend-providers";
import { getDb } from "@/server/db";
import { isDemoMode } from "@/server/env";
import { createCanonicalApprovalRecord } from "@/server/security/approval";
import { canonicalJson } from "@/server/security/canonical-json";
import { readIdempotent, updateSpec, writeIdempotent } from "@/workflows/demo-store";
import { handleRouteError, mutationContext, ok, requestId } from "@/workflows/http";

type Context = { params: Promise<{ specId: string }> };

const specPatchSchema = z
  .object({
    title: z.string().trim().min(2).max(120).optional(),
    summary: z.string().trim().min(10).max(5_000).optional(),
    audience: z.string().trim().min(2).max(2_000).optional(),
    jobs: z.array(z.string().trim().min(2).max(500)).min(1).max(30).optional(),
    features: z
      .array(
        z.object({
          name: z.string().trim().min(2).max(120),
          description: z.string().trim().min(10).max(1_000),
          acceptance: z.array(z.string().trim().min(2).max(500)).min(1).max(20),
        }),
      )
      .min(1)
      .max(30)
      .optional(),
    nonGoals: z.array(z.string().trim().min(2).max(500)).max(30).optional(),
  })
  .strict();

export async function PATCH(request: Request, { params }: Context) {
  const id = requestId(request);
  try {
    const context = await mutationContext(request, { requireVersion: true });
    const cached = readIdempotent<unknown>(context.idempotencyKey);
    if (cached) return ok(cached, context.requestId);
    const { specId } = await params;
    const rawBody: unknown = await request.json();
    if (!isDemoMode()) {
      const body = ProductSpecPatchInputSchema.parse(rawBody);
      if (body.optimisticVersion !== context.expectedVersion) throw new Error("Specification version does not match If-Match.");
      const providerAccounts = await getBackendBuildProviderAccounts(context.owner.workspaceId);
      const db = getDb();
      const result = await db.$transaction(async (tx) => {
        const current = await tx.productSpecVersion.findFirst({
          where: { id: specId, workspaceId: context.owner.workspaceId },
          include: { project: true },
        });
        if (!current) throw new Error("Specification not found.");
        if (current.optimisticVersion !== context.expectedVersion) throw new Error("Specification version conflict.");
        const latest = await tx.productSpecVersion.aggregate({ where: { projectId: current.projectId }, _max: { version: true } });
        const contentHash = createHash("sha256").update(canonicalJson(body.spec)).digest("hex");
        const created = await tx.productSpecVersion.create({
          data: {
            workspaceId: current.workspaceId,
            projectId: current.projectId,
            basedOnFindingId: current.basedOnFindingId,
            version: (latest._max.version ?? current.version) + 1,
            status: "PENDING_APPROVAL",
            content: body.spec,
            contentHash,
            model: null,
            promptVersion: null,
            schemaVersion: current.schemaVersion,
            createdByUserId: context.owner.userId,
          },
        });
        await tx.productSpecVersion.update({
          where: { id: current.id },
          data: { status: "SUPERSEDED", supersededAt: new Date(), optimisticVersion: { increment: 1 } },
        });
        await tx.approval.updateMany({
          where: {
            workspaceId: current.workspaceId,
            projectId: current.projectId,
            status: "PENDING",
            OR: [{ kind: "SPECIFICATION_BUILD" }, { specVersionId: current.id }],
          },
          data: { status: "SUPERSEDED", optimisticVersion: { increment: 1 } },
        });
        const projectConfig = ProjectConfigSchema.parse(current.project.config);
        const payload: ApprovalPayload = {
          kind: "specification_build",
          workspaceId: current.workspaceId,
          projectId: current.projectId,
          projectOptimisticVersion: current.project.optimisticVersion + 1,
          providerAccounts,
          costCeilingMicros: projectConfig.maxCostMicrosPerRun,
          expiresAt: new Date(Date.now() + 72 * 60 * 60_000).toISOString(),
          specVersionId: created.id,
          specVersion: created.version,
          specOptimisticVersion: created.optimisticVersion,
          specHash: created.contentHash,
        };
        const canonical = createCanonicalApprovalRecord(payload);
        const approval = await tx.approval.create({
          data: {
            workspaceId: current.workspaceId,
            projectId: current.projectId,
            kind: "SPECIFICATION_BUILD",
            payload: canonical.payload,
            payloadCanonical: canonical.payloadCanonical,
            payloadHash: canonical.payloadHash,
            specVersionId: created.id,
            expiresAt: new Date(payload.expiresAt),
          },
        });
        await tx.project.update({
          where: { id: current.projectId },
          data: {
            status: "AWAITING_SPEC_APPROVAL",
            currentSpecVersionId: created.id,
            currentBlocker: "Updated specification approval required",
            optimisticVersion: { increment: 1 },
          },
        });
        return { spec: created, approval };
      });
      return ok(result, context.requestId);
    }
    const structured = ProductSpecPatchInputSchema.safeParse(rawBody);
    const parsed = structured.success ? null : specPatchSchema.parse(rawBody);
    const patch = structured.success
      ? {
          title: structured.data.spec.productName,
          summary: structured.data.spec.oneLinePitch,
          audience: structured.data.spec.targetAudience,
          jobs: structured.data.spec.userStories.map((story) => `${story.actor} needs ${story.need} so ${story.outcome}`),
          features: structured.data.spec.inScope.map((feature) => ({
            name: feature,
            description: `Implement ${feature} within the approved product boundary.`,
            acceptance: structured.data.spec.acceptanceCriteria,
          })),
          nonGoals: structured.data.spec.outOfScope,
        }
      : Object.fromEntries(Object.entries(parsed!).filter((entry) => entry[1] !== undefined)) as {
          [K in keyof typeof parsed]?: NonNullable<(typeof parsed)[K]>;
        };
    const result = updateSpec({ specId, expectedVersion: context.expectedVersion!, patch });
    writeIdempotent(context.idempotencyKey, result);
    return ok(result, context.requestId);
  } catch (error) {
    return handleRouteError(error, id);
  }
}
