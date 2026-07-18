import { z } from "zod";

import { searchApprovedSubreddits } from "@/integrations/reddit";
import { getBackendRedditCredentials } from "@/server/backend-providers";
import { assertOwnerRequest, route } from "@/workflows/http";

const QuerySchema = z.object({
  q: z.string().trim().min(2).max(200),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  after: z.string().trim().min(1).optional(),
}).strict();

export function GET(request: Request) {
  return route(request, async () => {
    const owner = await assertOwnerRequest(request);
    const query = QuerySchema.parse(Object.fromEntries(new URL(request.url).searchParams));
    return searchApprovedSubreddits({
      credentials: await getBackendRedditCredentials(owner.workspaceId),
      query: query.q,
      limit: query.limit,
      ...(query.after ? { after: query.after } : {}),
    });
  });
}
