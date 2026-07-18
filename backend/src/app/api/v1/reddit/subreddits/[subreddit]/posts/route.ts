import { z } from "zod";

import { listApprovedSubreddit } from "@/integrations/reddit";
import { getBackendRedditCredentials } from "@/server/backend-providers";
import { assertOwnerRequest, route } from "@/workflows/http";

type Context = { params: Promise<{ subreddit: string }> };

const QuerySchema = z.object({
  sort: z.enum(["hot", "new", "top", "rising"]).default("new"),
  time: z.enum(["hour", "day", "week", "month", "year", "all"]).default("year"),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  after: z.string().trim().min(1).optional(),
}).strict();

export function GET(request: Request, { params }: Context) {
  return route(request, async () => {
    const owner = await assertOwnerRequest(request);
    const { subreddit } = await params;
    const query = QuerySchema.parse(Object.fromEntries(new URL(request.url).searchParams));
    return listApprovedSubreddit({
      credentials: await getBackendRedditCredentials(owner.workspaceId),
      subreddit,
      sort: query.sort,
      time: query.time,
      limit: query.limit,
      ...(query.after ? { after: query.after } : {}),
    });
  });
}
