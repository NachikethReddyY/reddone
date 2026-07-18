import { getAuth } from "@/server/better-auth";
import { isDemoMode } from "@/server/env";
import { handleRouteError, mutationContext, ok, requestId } from "@/workflows/http";

export async function POST(request: Request) {
  const id = requestId(request);
  try {
    const context = await mutationContext(request);
    if (!isDemoMode()) await getAuth().api.revokeOtherSessions({ headers: request.headers });
    return ok({ success: true as const }, context.requestId);
  } catch (error) {
    return handleRouteError(error, id);
  }
}
