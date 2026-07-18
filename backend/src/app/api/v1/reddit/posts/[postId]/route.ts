import { z } from "zod";

import { getApprovedPostThread } from "@/integrations/reddit";
import { getBackendRedditCredentials } from "@/server/backend-providers";
import { assertOwnerRequest, route } from "@/workflows/http";

type Context = { params: Promise<{ postId: string }> };

const QuerySchema = z.object({
  commentLimit: z.coerce.number().int().min(1).max(100).default(50),
  commentDepth: z.coerce.number().int().min(1).max(10).default(4),
  commentSort: z.enum(["confidence", "top", "new", "controversial", "old", "qa"]).default("confidence"),
}).strict();

export function GET(request: Request, { params }: Context) {
  return route(request, async () => {
    const owner = await assertOwnerRequest(request);
    const { postId } = await params;
    const query = QuerySchema.parse(Object.fromEntries(new URL(request.url).searchParams));
    return getApprovedPostThread({
      credentials: await getBackendRedditCredentials(owner.workspaceId),
      postId,
      commentLimit: query.commentLimit,
      commentDepth: query.commentDepth,
      commentSort: query.commentSort,
    });
  });
}
