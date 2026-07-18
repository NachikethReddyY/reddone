import { z } from "zod";

import { getProjectConversation } from "@/server/conversation-repository";
import { isDemoMode } from "@/server/env";
import { assertOwnerRequest, HttpError, route } from "@/workflows/http";

type Context = { params: Promise<{ projectId: string; conversationId: string }> };

const QuerySchema = z.object({ cursor: z.string().regex(/^\d+$/).optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }).strict();

export async function GET(request: Request, { params }: Context) {
  const { projectId, conversationId } = await params;
  return route(request, async () => {
    if (isDemoMode()) throw new HttpError("unavailable", "Durable conversations are unavailable in demo mode.", 503);
    const owner = await assertOwnerRequest(request);
    const url = new URL(request.url);
    const query = QuerySchema.parse({ cursor: url.searchParams.get("cursor") ?? undefined, limit: url.searchParams.get("limit") ?? undefined });
    const detail = await getProjectConversation({
      workspaceId: owner.workspaceId,
      projectId,
      conversationId,
      ...(query.cursor ? { cursor: Number(query.cursor) } : {}),
      limit: query.limit,
    });
    if (!detail) throw new HttpError("not_found", "Conversation not found.", 404);
    return detail;
  });
}
