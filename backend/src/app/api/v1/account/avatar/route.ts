import { AccountAvatarUpdateInputSchema } from "@/contracts/account";
import { createDemoAccountProfile, updateAccountAvatar } from "@/server/account";
import { normalizeAvatarDataUrl } from "@/server/avatar";
import { isDemoMode } from "@/server/env";
import { handleRouteError, mutationContext, ok, parseJson, requestId } from "@/workflows/http";

export const runtime = "nodejs";

export async function PUT(request: Request) {
  const id = requestId(request);
  try {
    const context = await mutationContext(request);
    const input = await parseJson(request, AccountAvatarUpdateInputSchema);
    const image = await normalizeAvatarDataUrl(input.image);
    if (isDemoMode()) return ok(createDemoAccountProfile({}, image), context.requestId);
    return ok(await updateAccountAvatar(context.owner, image), context.requestId);
  } catch (error) {
    return handleRouteError(error, id);
  }
}
