import { z } from "zod";

import { isDemoMode } from "@/server/env";
import { createProjectSecretGrantProposal } from "@/server/project-secret-grants";
import { handleRouteError, HttpError, mutationContext, ok, requestId } from "@/workflows/http";

type Context = { params: Promise<{ projectId: string }> };

const GrantProposalInputSchema = z
  .object({
    artifactId: z.string().trim().min(1).max(128),
    secretVersionIds: z.array(z.string().trim().min(1).max(128)).min(1).max(100),
    costCeilingMicros: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(0),
    expiresAt: z.string().datetime({ offset: true }),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.secretVersionIds).size !== value.secretVersionIds.length) {
      context.addIssue({ code: "custom", path: ["secretVersionIds"], message: "Secret versions must be unique." });
    }
    const expiresAt = new Date(value.expiresAt).getTime();
    if (expiresAt <= Date.now() + 5 * 60_000) {
      context.addIssue({ code: "custom", path: ["expiresAt"], message: "Grant approvals must remain valid for at least five minutes." });
    }
    if (expiresAt > Date.now() + 7 * 24 * 60 * 60_000) {
      context.addIssue({ code: "custom", path: ["expiresAt"], message: "Grant approvals may not remain valid for more than seven days." });
    }
  });

export async function POST(request: Request, { params }: Context) {
  const id = requestId(request);
  try {
    const context = await mutationContext(request, { requireVersion: true });
    if (isDemoMode()) {
      throw new HttpError("feature_disabled", "Demo mode discards project secrets and cannot propose runtime grants.", 403);
    }
    const { projectId } = await params;
    const body = GrantProposalInputSchema.parse(await request.json());
    const result = await createProjectSecretGrantProposal({
      workspaceId: context.owner.workspaceId,
      projectId,
      artifactId: body.artifactId,
      secretVersionIds: body.secretVersionIds,
      expectedProjectVersion: context.expectedVersion!,
      costCeilingMicros: body.costCeilingMicros,
      expiresAt: new Date(body.expiresAt),
      actorUserId: context.owner.userId,
      requestId: context.requestId,
      idempotencyKey: context.idempotencyKey,
    });
    return ok(result, context.requestId, { status: result.replayed ? 200 : 201 });
  } catch (error) {
    return handleRouteError(error, id);
  }
}
