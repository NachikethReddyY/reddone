import { getOwnedSessionToken } from "@/server/account";
import { getAuth, getAuthenticatedSession } from "@/server/better-auth";
import { isDemoMode } from "@/server/env";
import { HttpError, handleRouteError, mutationContext, ok, requestId } from "@/workflows/http";

export async function DELETE(request: Request, { params }: { params: Promise<{ sessionId: string }> }) {
  const id = requestId(request);
  try {
    const context = await mutationContext(request);
    const { sessionId } = await params;
    if (isDemoMode()) return ok({ success: true as const }, context.requestId);
    const current = await getAuthenticatedSession(request);
    if (!current?.session.id) throw new HttpError("unauthenticated", "Sign in is required.", 401);
    if (sessionId === current.session.id) throw new HttpError("bad_request", "Use sign out to end the current session.", 400);
    const token = await getOwnedSessionToken(context.owner, sessionId);
    await getAuth().api.revokeSession({ headers: request.headers, body: { token } });
    return ok({ success: true as const }, context.requestId);
  } catch (error) {
    return handleRouteError(error, id);
  }
}
