import { getDb } from "@/server/db";
import { isDemoMode } from "@/server/env";
import { assertOwnerRequest, HttpError, route } from "@/workflows/http";

type Context = { params: Promise<{ deploymentId: string }> };

export async function GET(request: Request, { params }: Context) {
  const { deploymentId } = await params;
  return route(request, async () => {
    const owner = await assertOwnerRequest(request);
    if (isDemoMode()) {
      return { deploymentId, mode: "demo", status: "healthy", checkedAt: new Date().toISOString(), externalCallMade: false };
    }
    const deployment = await getDb().deployment.findFirst({
      where: { id: deploymentId, workspaceId: owner.workspaceId },
    });
    if (!deployment) throw new HttpError("not_found", "Deployment not found.", 404);
    return {
      deploymentId,
      status: deployment.status.toLowerCase(),
      url: deployment.url,
      healthCheckUrl: deployment.healthCheckUrl,
      healthFailure: deployment.healthFailure,
      lastKnownGood: deployment.lastKnownGood,
      checkedAt: deployment.updatedAt.toISOString(),
    };
  });
}
