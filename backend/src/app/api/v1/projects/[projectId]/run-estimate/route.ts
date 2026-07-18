import { RunEstimateInputSchema } from "@/contracts";
import { isDemoMode } from "@/server/env";
import { estimateDemoProjectRun, estimateProjectRun } from "@/server/usage-estimator";
import {
  assertOwnerRequest,
  assertSameOrigin,
  handleRouteError,
  ok,
  parseJson,
  requestId,
} from "@/workflows/http";

type Context = { params: Promise<{ projectId: string }> };

export async function POST(request: Request, { params }: Context) {
  const id = requestId(request);
  try {
    const owner = await assertOwnerRequest(request);
    assertSameOrigin(request);
    const { projectId } = await params;
    const body = await parseJson(request, RunEstimateInputSchema);
    const estimateInput = {
      projectId,
      kind: body.kind,
      ...(body.model ? { model: body.model } : {}),
    };
    const estimate = isDemoMode()
      ? estimateDemoProjectRun(estimateInput)
      : await estimateProjectRun({ workspaceId: owner.workspaceId, ...estimateInput });
    return ok(estimate, id);
  } catch (error) {
    return handleRouteError(error, id);
  }
}
