import { z } from "zod";

import type { ApprovalPayload } from "@/contracts";
import { getDb } from "@/server/db";
import { isDemoMode } from "@/server/env";
import { createCanonicalApprovalRecord } from "@/server/security/approval";
import { handleRouteError, HttpError, mutationContext, ok, requestId } from "@/workflows/http";

type Context = { params: Promise<{ deploymentId: string }> };

export async function POST(request: Request, { params }: Context) {
  const id = requestId(request);
  try {
    const context = await mutationContext(request, { requireVersion: true });
    if (isDemoMode()) {
      return ok({ mode: "demo", message: "Demo rollback is proposed but does not change an external deployment." }, context.requestId, { status: 201 });
    }
    const { deploymentId } = await params;
    const body = z
      .object({ targetDeploymentId: z.string().uuid(), costCeilingMicros: z.number().int().min(0).max(5_000_000).default(500_000) })
      .strict()
      .parse(await request.json());
    const db = getDb();
    const [current, target, vercel] = await Promise.all([
      db.deployment.findFirst({ where: { id: deploymentId, workspaceId: context.owner.workspaceId } }),
      db.deployment.findFirst({ where: { id: body.targetDeploymentId, workspaceId: context.owner.workspaceId } }),
      db.providerConnection.findUnique({
        where: { workspaceId_provider: { workspaceId: context.owner.workspaceId, provider: "VERCEL" } },
      }),
    ]);
    if (!current || current.optimisticVersion !== context.expectedVersion) throw new HttpError("precondition_failed", "Deployment version conflict.", 412);
    if (!target || target.projectId !== current.projectId || !target.url) throw new HttpError("bad_request", "Rollback target is not a valid deployment for this project.", 400);
    if (!vercel || vercel.health !== "HEALTHY") throw new HttpError("feature_disabled", "Vercel must be healthy before rollback approval.", 503);
    const payload: ApprovalPayload = {
      kind: "rollback",
      workspaceId: context.owner.workspaceId,
      projectId: current.projectId,
      projectOptimisticVersion: (await db.project.findUniqueOrThrow({ where: { id: current.projectId } })).optimisticVersion,
      providerAccounts: [{ provider: "vercel", accountId: vercel.accountExternalId ?? vercel.id }],
      costCeilingMicros: body.costCeilingMicros,
      expiresAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
      deploymentId: current.id,
      deploymentOptimisticVersion: current.optimisticVersion,
      targetDeploymentId: target.id,
      targetArtifactHash: target.artifactHash,
    };
    const canonical = createCanonicalApprovalRecord(payload);
    const approval = await db.approval.create({
      data: {
        workspaceId: context.owner.workspaceId,
        projectId: current.projectId,
        kind: "ROLLBACK",
        payload: canonical.payload,
        payloadCanonical: canonical.payloadCanonical,
        payloadHash: canonical.payloadHash,
        artifactId: target.artifactId,
        expiresAt: new Date(payload.expiresAt),
      },
    });
    return ok({ id: approval.id, kind: "rollback", status: "pending", payload: canonical.payload, payloadHash: canonical.payloadHash, optimisticVersion: 0 }, context.requestId, { status: 201 });
  } catch (error) {
    return handleRouteError(error, id);
  }
}
