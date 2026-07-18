import { CreateTurnInputSchema } from "@/contracts";
import { createConversationTurn } from "@/server/conversation-repository";
import { isDemoMode } from "@/server/env";
import { assertNoSecretLikeInput } from "@/server/security/redaction";
import { handleRouteError, HttpError, mutationContext, ok, requestId } from "@/workflows/http";
import { dispatchConversationTurn } from "@/workflows/conversation-dispatch";

type Context = { params: Promise<{ projectId: string; conversationId: string }> };

export async function POST(request: Request, { params }: Context) {
  const id = requestId(request);
  try {
    const context = await mutationContext(request, { requireVersion: true });
    if (isDemoMode()) throw new HttpError("unavailable", "Durable conversations are unavailable in demo mode.", 503);
    const { projectId, conversationId } = await params;
    const body = CreateTurnInputSchema.parse(await request.json());
    assertNoSecretLikeInput(body.message);
    const created = await createConversationTurn({
      workspaceId: context.owner.workspaceId,
      projectId,
      conversationId,
      ownerUserId: context.owner.userId,
      message: body.message,
      idempotencyKey: context.idempotencyKey,
      expectedProjectVersion: context.expectedVersion!,
    });
    const turn = created.turn;
    const executorRunId = created.replayed ? null : await dispatchConversationTurn(context.owner.workspaceId, turn.id);
    return ok({
      id: turn.id,
      status: turn.status.toLowerCase(),
      streamUrl: new URL(`/api/v1/projects/${projectId}/conversation/${conversationId}/turns/${turn.id}/events`, request.url).toString(),
      replayed: created.replayed,
      dispatchStatus: executorRunId ? "dispatched" : "pending",
    }, context.requestId, { status: 202 });
  } catch (error) {
    return handleRouteError(error, id);
  }
}
