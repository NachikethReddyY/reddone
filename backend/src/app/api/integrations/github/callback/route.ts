import { NextResponse } from "next/server";

import { testGitHubInstallation } from "@/integrations/github";
import { verifyOAuthState } from "@/policy/oauth-state";
import { saveOAuthConnection } from "@/server/secret-vault";
import { updateConnectionMetadata } from "@/workflows/demo-store";
import { assertOwnerRequest, HttpError } from "@/workflows/http";
import { getRuntimeConfig, isDemoMode } from "@/server/env";

export async function GET(request: Request) {
  try {
    const runtime = getRuntimeConfig();
    const owner = await assertOwnerRequest(request);
    const url = new URL(request.url);
    const stateValue = url.searchParams.get("state");
    const installationId = url.searchParams.get("installation_id");
    const setupAction = url.searchParams.get("setup_action");
    if (!stateValue) throw new HttpError("bad_request", "GitHub callback state is missing.", 400);
    const state = verifyOAuthState(stateValue, "github");
    const cookieNonce = request.headers.get("cookie")?.match(/(?:^|;\s*)reddone_github_state=([^;]+)/)?.[1];
    if (!cookieNonce || decodeURIComponent(cookieNonce) !== state.nonce) throw new HttpError("forbidden", "GitHub callback session mismatch.", 403);
    if (!installationId || setupAction === "cancel") {
      const canceled = new URL(state.returnTo, process.env.NEXT_PUBLIC_APP_URL ?? request.url);
      canceled.searchParams.set("connection", "github");
      canceled.searchParams.set("outcome", "consent_canceled");
      return NextResponse.redirect(canceled);
    }

    let account = "GitHub App installation";
    if (!isDemoMode()) {
      const appId = process.env.GITHUB_APP_ID;
      const privateKey = process.env.GITHUB_APP_PRIVATE_KEY?.replaceAll("\\n", "\n");
      if (!appId || !privateKey) throw new HttpError("feature_disabled", "GitHub App credentials are incomplete.", 503);
      const verified = await testGitHubInstallation({ appId, privateKey, installationId });
      account = verified.account;
      if (
        runtime.deploymentMode === "private"
        && process.env.GITHUB_ALLOWED_ACCOUNT
        && account.toLowerCase() !== process.env.GITHUB_ALLOWED_ACCOUNT.toLowerCase()
      ) {
        throw new HttpError("forbidden", "The GitHub App was installed on a different account than the configured workspace account.", 403);
      }
      await saveOAuthConnection({
        workspaceId: owner.workspaceId,
        provider: "github",
        accountId: installationId,
        accountLabel: account,
        scopes: verified.scopes,
      });
    }
    if (isDemoMode()) updateConnectionMetadata("github", {
      mode: "demo",
      status: "healthy",
      account,
      scopes: ["administration:write", "contents:write", "metadata:read"],
      maskedSuffix: installationId.slice(-4),
      lastTestedAt: new Date().toISOString(),
      message:
        "Demo installation callback accepted; no external side effect will be promoted.",
    });
    const destination = new URL(state.returnTo, process.env.NEXT_PUBLIC_APP_URL ?? request.url);
    destination.searchParams.set("connection", "github");
    destination.searchParams.set("outcome", "connected");
    const response = NextResponse.redirect(destination);
    response.cookies.delete("reddone_github_state");
    return response;
  } catch (error) {
    const destination = new URL("/connections", process.env.NEXT_PUBLIC_APP_URL ?? request.url);
    destination.searchParams.set("connection", "github");
    destination.searchParams.set(
      "outcome",
      error instanceof HttpError && /different account|wrong account/i.test(error.message)
        ? "wrong_account"
        : error instanceof HttpError && /scope/i.test(error.message)
          ? "insufficient_scopes"
          : "callback_error",
    );
    const response = NextResponse.redirect(destination);
    response.cookies.delete("reddone_github_state");
    return response;
  }
}
