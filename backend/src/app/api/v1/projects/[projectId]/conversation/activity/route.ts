import { z } from "zod";

import { listConversationActivity } from "@/server/conversation-repository";
import { isDemoMode } from "@/server/env";
import { assertOwnerRequest, HttpError, route } from "@/workflows/http";

type Context = { params: Promise<{ projectId: string }> };

const QuerySchema = z.object({ cursor: z.string().regex(/^\d+$/).optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }).strict();

export async function GET(request: Request, { params }: Context) {
  const { projectId } = await params;
  return route(request, async () => {
    if (isDemoMode()) return { items: [], nextCursor: null };
    const owner = await assertOwnerRequest(request);
    const url = new URL(request.url);
    const query = QuerySchema.parse({ cursor: url.searchParams.get("cursor") ?? undefined, limit: url.searchParams.get("limit") ?? undefined });
    if (query.cursor && BigInt(query.cursor) > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new HttpError("bad_request", "Activity cursor is outside the safe range.", 400);
    }
    return listConversationActivity({ workspaceId: owner.workspaceId, projectId, ...(query.cursor ? { cursor: BigInt(query.cursor) } : {}), limit: query.limit });
  });
}
