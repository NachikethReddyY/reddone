import { executeConversationAction } from "@/server/conversation-actions";
import { isDemoMode } from "@/server/env";
import { handleRouteError, HttpError, mutationContext, ok, requestId } from "@/workflows/http";

type Context = { params: Promise<{ projectId: string; conversationId: string; actionId: string }> };

export async function POST(request: Request, { params }: Context) {
  const id = requestId(request);
  try {
    const context = await mutationContext(request, { requireVersion: true });
    if (isDemoMode()) throw new HttpError("unavailable", "Durable conversations are unavailable in demo mode.", 503);
    const { projectId, conversationId, actionId } = await params;
    const result = await executeConversationAction({
      workspaceId: context.owner.workspaceId,
      projectId,
      conversationId,
      actionId,
      expectedProjectVersion: context.expectedVersion!,
      actorUserId: context.owner.userId,
      requestId: context.requestId,
    });
    return ok(result, context.requestId);
  } catch (error) {
    return handleRouteError(error, id);
  }
}
