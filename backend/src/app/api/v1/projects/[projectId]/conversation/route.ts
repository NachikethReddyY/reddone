import { CreateConversationInputSchema } from "@/contracts";
import { createProjectConversation, listProjectConversations } from "@/server/conversation-repository";
import { isDemoMode } from "@/server/env";
import { assertOwnerRequest, handleRouteError, HttpError, mutationContext, ok, requestId, route } from "@/workflows/http";

type Context = { params: Promise<{ projectId: string }> };

export async function GET(request: Request, { params }: Context) {
  const { projectId } = await params;
  return route(request, async () => {
    if (isDemoMode()) return { items: [] };
    const owner = await assertOwnerRequest(request);
    return { items: await listProjectConversations({ workspaceId: owner.workspaceId, projectId }) };
  });
}

export async function POST(request: Request, { params }: Context) {
  const id = requestId(request);
  try {
    const context = await mutationContext(request, { requireVersion: true });
    if (isDemoMode()) throw new HttpError("unavailable", "Durable conversations are unavailable in demo mode.", 503);
    const { projectId } = await params;
    const body = CreateConversationInputSchema.parse(await request.json());
    const conversation = await createProjectConversation({ workspaceId: context.owner.workspaceId, projectId, title: body.title });
    return ok(conversation, context.requestId, { status: 201 });
  } catch (error) {
    return handleRouteError(error, id);
  }
}
