import { z } from "zod";

import { searchApprovedRedditPage } from "@/integrations/reddit";
import { getBackendRedditCredentials } from "@/server/backend-providers";
import { assertOwnerRequest, route } from "@/workflows/http";

const SearchQuerySchema = z.object({
  q: z.string().trim().min(2).max(200),
  subreddit: z.string().trim().min(2).max(23).optional(),
  sort: z.enum(["relevance", "hot", "top", "new", "comments"]).default("relevance"),
  time: z.enum(["hour", "day", "week", "month", "year", "all"]).default("year"),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  after: z.string().trim().min(1).optional(),
}).strict();

export function GET(request: Request) {
  return route(request, async () => {
    const owner = await assertOwnerRequest(request);
    const query = SearchQuerySchema.parse(Object.fromEntries(new URL(request.url).searchParams));
    return searchApprovedRedditPage({
      credentials: await getBackendRedditCredentials(owner.workspaceId),
      query: query.q,
      ...(query.subreddit ? { subreddit: query.subreddit } : {}),
      sort: query.sort,
      time: query.time,
      limit: query.limit,
      ...(query.after ? { after: query.after } : {}),
    });
  });
}
