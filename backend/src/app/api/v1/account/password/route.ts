import { ChangePasswordInputSchema } from "@/contracts/account";
import { getAuth } from "@/server/better-auth";
import { apiError, handleRouteError, mutationContext, ok, parseJson, requestId } from "@/workflows/http";

function copyCookies(source: Headers, target: Headers) {
  const values = typeof source.getSetCookie === "function" ? source.getSetCookie() : [source.get("set-cookie")].filter((value): value is string => Boolean(value));
  for (const value of values) target.append("set-cookie", value);
}

export async function POST(request: Request) {
  const id = requestId(request);
  try {
    const context = await mutationContext(request);
    const input = await parseJson(request, ChangePasswordInputSchema);
    const authResponse = await getAuth().api.changePassword({
      headers: request.headers,
      body: input,
      asResponse: true,
    });
    if (!authResponse.ok) {
      const payload = await authResponse.json().catch(() => null) as { message?: string } | null;
      return apiError(context.requestId, "bad_request", payload?.message ?? "The password could not be changed.", authResponse.status);
    }
    const response = ok({ success: true as const }, context.requestId);
    copyCookies(authResponse.headers, response.headers);
    return response;
  } catch (error) {
    return handleRouteError(error, id);
  }
}
