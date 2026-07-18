import { isDemoMode } from "@/server/env";
import { resetDemoStore } from "@/workflows/demo-store";
import { handleRouteError, HttpError, mutationContext, ok, requestId } from "@/workflows/http";

export async function POST(request: Request) {
  const id = requestId(request);
  try {
    const context = await mutationContext(request);
    if (!isDemoMode()) throw new HttpError("forbidden", "Demo reset is disabled outside demo mode.", 403);
    resetDemoStore();
    return ok({ reset: true }, context.requestId);
  } catch (error) {
    return handleRouteError(error, id);
  }
}
