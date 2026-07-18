import { NextResponse } from "next/server";

import { createVercelAuthorizationUrl } from "@/integrations/vercel";
import { createOAuthState } from "@/policy/oauth-state";
import { assertOwnerRequest, handleRouteError, requestId } from "@/workflows/http";

export async function GET(request: Request) {
  const id = requestId(request);
  try {
    await assertOwnerRequest(request);
    const returnTo = new URL(request.url).searchParams.get("returnTo") ?? "/connections";
    const { state, payload } = createOAuthState("vercel", returnTo);
    const response = NextResponse.redirect(createVercelAuthorizationUrl({ state }));
    // Vercel's external-installation flow monitors this popup until it returns
    // to the supplied completion URL. Keep strict opener isolation elsewhere.
    response.headers.set("Cross-Origin-Opener-Policy", "unsafe-none");
    response.cookies.set("reddone_vercel_state", payload.nonce, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/api/integrations/vercel/callback",
      maxAge: 10 * 60,
    });
    return response;
  } catch (error) {
    const response = handleRouteError(error, id);
    response.headers.set("Cross-Origin-Opener-Policy", "unsafe-none");
    return response;
  }
}
