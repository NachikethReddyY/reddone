import { AccountUpdateInputSchema } from "@/contracts/account";
import { createDemoAccountProfile, getAccountProfile, updateAccountProfile } from "@/server/account";
import { isDemoMode } from "@/server/env";
import { handleRouteError, mutationContext, ok, parseJson, requestId, route } from "@/workflows/http";

export function GET(request: Request) {
  return route(request, async () => {
    if (isDemoMode()) return createDemoAccountProfile();
    const { assertOwnerRequest } = await import("@/workflows/http");
    return getAccountProfile(await assertOwnerRequest(request));
  });
}

export async function PATCH(request: Request) {
  const id = requestId(request);
  try {
    const context = await mutationContext(request);
    const input = await parseJson(request, AccountUpdateInputSchema);
    if (isDemoMode()) return ok(createDemoAccountProfile(input), context.requestId);
    return ok(await updateAccountProfile(context.owner, input), context.requestId);
  } catch (error) {
    return handleRouteError(error, id);
  }
}
