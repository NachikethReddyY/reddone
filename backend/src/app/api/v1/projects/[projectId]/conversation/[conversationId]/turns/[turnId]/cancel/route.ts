import { isDemoMode } from "@/server/env";
import { requestConversationTurnCancellation } from "@/server/conversation-repository";
import { handleRouteError, HttpError, mutationContext, ok, requestId } from "@/workflows/http";

type Context = { params: Promise<{ projectId: string; conversationId: string; turnId: string }> };

export async function POST(request: Request, { params }: Context) {
  const id = requestId(request);
  try {
    const context = await mutationContext(request, { requireVersion: true });
    if (isDemoMode()) throw new HttpError("unavailable", "Durable conversations are unavailable in demo mode.", 503);
    const { projectId, conversationId, turnId } = await params;
    await requestConversationTurnCancellation({ workspaceId: context.owner.workspaceId, projectId, conversationId, turnId, expectedProjectVersion: context.expectedVersion! });
    return ok({ canceled: false, cancellationRequested: true, turnId }, context.requestId, { status: 202 });
  } catch (error) {
    return handleRouteError(error, id);
  }
}
