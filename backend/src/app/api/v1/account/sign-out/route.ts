import { getAuth } from "@/server/better-auth";
import { isDemoMode } from "@/server/env";
import { apiError, handleRouteError, mutationContext, ok, requestId } from "@/workflows/http";

function copyCookies(source: Headers, target: Headers) {
  const values = typeof source.getSetCookie === "function" ? source.getSetCookie() : [source.get("set-cookie")].filter((value): value is string => Boolean(value));
  for (const value of values) target.append("set-cookie", value);
}

export async function POST(request: Request) {
  const id = requestId(request);
  try {
    const context = await mutationContext(request);
    if (isDemoMode()) return ok({ success: true as const }, context.requestId);
    const authResponse = await getAuth().api.signOut({ headers: request.headers, asResponse: true });
    if (!authResponse.ok) return apiError(context.requestId, "bad_request", "Sign out failed.", authResponse.status);
    const response = ok({ success: true as const }, context.requestId);
    copyCookies(authResponse.headers, response.headers);
    return response;
  } catch (error) {
    return handleRouteError(error, id);
  }
}
