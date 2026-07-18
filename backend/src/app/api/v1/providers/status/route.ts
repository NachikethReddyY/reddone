import { getBackendProviderReadiness } from "@/server/backend-providers";
import { assertOwnerRequest, route } from "@/workflows/http";

export function GET(request: Request) {
  return route(request, async () => {
    const owner = await assertOwnerRequest(request);
    return getBackendProviderReadiness(owner.workspaceId);
  });
}
