import { listWorkspaceApprovals } from "@/server/approval-repository";
import { isDemoMode } from "@/server/env";
import { listApprovals } from "@/workflows/demo-store";
import { assertOwnerRequest, route } from "@/workflows/http";

export function GET(request: Request) {
  return route(request, async () => {
    const projectId = new URL(request.url).searchParams.get("projectId") ?? undefined;
    if (!isDemoMode()) {
      const owner = await assertOwnerRequest(request);
      return { items: await listWorkspaceApprovals(owner.workspaceId, projectId) };
    }
    return { items: listApprovals(projectId) };
  });
}
