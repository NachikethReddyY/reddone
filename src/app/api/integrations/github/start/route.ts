import { NextResponse } from "next/server";

import { createOAuthState } from "@/policy/oauth-state";
import { assertOwnerRequest, handleRouteError, HttpError, requestId } from "@/workflows/http";

export async function GET(request: Request) {
  const id = requestId(request);
  try {
    await assertOwnerRequest(request);
    const slug = process.env.GITHUB_APP_SLUG;
    if (!slug) throw new HttpError("feature_disabled", "GitHub App installation is not configured.", 503);
    const returnTo = new URL(request.url).searchParams.get("returnTo") ?? "/connections";
    const { state, payload } = createOAuthState("github", returnTo);
    const destination = new URL(`https://github.com/apps/${slug}/installations/new`);
    destination.searchParams.set("state", state);
    const response = NextResponse.redirect(destination);
    response.cookies.set("reddone_github_state", payload.nonce, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/api/integrations/github/callback",
      maxAge: 10 * 60,
    });
    return response;
  } catch (error) {
    return handleRouteError(error, id);
  }
}
