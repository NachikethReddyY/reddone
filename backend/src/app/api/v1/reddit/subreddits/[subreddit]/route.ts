import { getApprovedSubreddit } from "@/integrations/reddit";
import { getBackendRedditCredentials } from "@/server/backend-providers";
import { assertOwnerRequest, route } from "@/workflows/http";

type Context = { params: Promise<{ subreddit: string }> };

export function GET(request: Request, { params }: Context) {
  return route(request, async () => {
    const owner = await assertOwnerRequest(request);
    const { subreddit } = await params;
    return getApprovedSubreddit({
      credentials: await getBackendRedditCredentials(owner.workspaceId),
      subreddit,
    });
  });
}
