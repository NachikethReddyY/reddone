import { NextResponse } from "next/server";
import { z } from "zod";

import { IntegrationError } from "@/integrations/errors";
import {
  parseVercelInstallationCompletionUrl,
  requireVercelTeamInstallation,
  testVercelConnection,
} from "@/integrations/vercel";
import { verifyOAuthState } from "@/policy/oauth-state";
import { markConnectionTest, saveProviderCredential } from "@/server/secret-vault";
import { updateConnectionMetadata } from "@/workflows/demo-store";
import { assertOwnerRequest, HttpError } from "@/workflows/http";
import { getRuntimeConfig } from "@/server/env";

const tokenSchema = z.object({
  access_token: z.string(),
  token_type: z.string(),
  installation_id: z.string().optional(),
  team_id: z.string().nullable().optional(),
});

export async function GET(request: Request) {
  const runtime = getRuntimeConfig();
  try {
    const owner = await assertOwnerRequest(request);
    const url = new URL(request.url);
    const stateValue = url.searchParams.get("state");
    const code = url.searchParams.get("code");
    if (!stateValue) throw new HttpError("bad_request", "Vercel callback state is missing.", 400);
    const state = verifyOAuthState(stateValue, "vercel");
    const cookieNonce = request.headers.get("cookie")?.match(/(?:^|;\s*)reddone_vercel_state=([^;]+)/)?.[1];
    if (!cookieNonce || decodeURIComponent(cookieNonce) !== state.nonce) throw new HttpError("forbidden", "Vercel callback session mismatch.", 403);
    if (!code || url.searchParams.get("error")) {
      const canceled = new URL(state.returnTo, runtime.appUrl);
      canceled.searchParams.set("connection", "vercel");
      canceled.searchParams.set("outcome", "consent_canceled");
      const response = NextResponse.redirect(canceled);
      response.headers.set("Cross-Origin-Opener-Policy", "unsafe-none");
      response.cookies.delete("reddone_vercel_state");
      return response;
    }
    const installationCompletionUrl = parseVercelInstallationCompletionUrl(url.searchParams.get("next"));

    let accountId = "demo-team";
    let accountLabel = accountId;
    let suffix = "DEMO";
    if (runtime.mode === "live") {
      const clientId = process.env.VERCEL_INTEGRATION_CLIENT_ID;
      const clientSecret = process.env.VERCEL_INTEGRATION_CLIENT_SECRET;
      const redirectUri = `${runtime.appUrl}/api/integrations/vercel/callback`;
      if (!clientId || !clientSecret) throw new HttpError("feature_disabled", "Vercel OAuth credentials are incomplete.", 503);
      const tokenResponse = await fetch("https://api.vercel.com/v2/oauth/access_token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: redirectUri }),
        cache: "no-store",
      });
      if (!tokenResponse.ok) throw new HttpError("provider_unavailable", "Vercel token exchange failed.", 502, tokenResponse.status >= 500);
      const token = tokenSchema.parse(await tokenResponse.json());
      try {
        accountId = requireVercelTeamInstallation({
          teamId: token.team_id,
          allowedTeamId: runtime.deploymentMode === "private" ? process.env.VERCEL_ALLOWED_TEAM_ID : undefined,
        });
        const tested = await testVercelConnection(token.access_token, accountId);
        accountId = tested.accountId;
        accountLabel = tested.account;
      } catch (error) {
        if (!(error instanceof IntegrationError)) throw error;
        throw new HttpError(
          error.code === "not_configured" ? "feature_disabled" : error.code === "provider_error" ? "provider_unavailable" : "forbidden",
          error.message,
          error.status,
          error.retryable,
        );
      }
      suffix = token.access_token.slice(-4);
      const saved = await saveProviderCredential({
        workspaceId: owner.workspaceId,
        provider: "vercel",
        credential: token.access_token,
        accountId,
        accountLabel,
        scopes: ["project:write", "deployment:write", "env:write"],
        createdByUserId: owner.userId,
      });
      await markConnectionTest({
        workspaceId: owner.workspaceId,
        provider: "vercel",
        healthy: true,
        accountId,
        accountLabel,
        scopes: ["project:write", "deployment:write", "env:write"],
        testedSecretVersionId: saved.secretVersion.id,
      });
    }
    if (runtime.mode === "demo") updateConnectionMetadata("vercel", {
      mode: "demo",
      status: "healthy",
      account: accountLabel,
      scopes: ["project:write", "deployment:write", "env:write"],
      maskedSuffix: suffix,
      lastTestedAt: new Date().toISOString(),
      message: "Demo Vercel installation completed.",
    });
    const destination = installationCompletionUrl ?? new URL(state.returnTo, runtime.appUrl);
    if (!installationCompletionUrl) {
      destination.searchParams.set("connection", "vercel");
      destination.searchParams.set("outcome", "connected");
    }
    const response = NextResponse.redirect(destination);
    response.headers.set("Cross-Origin-Opener-Policy", "unsafe-none");
    response.cookies.delete("reddone_vercel_state");
    return response;
  } catch (error) {
    const destination = new URL("/connections", runtime.appUrl);
    destination.searchParams.set("connection", "vercel");
    destination.searchParams.set(
      "outcome",
      error instanceof HttpError && /different team|team installation|installed on a team|installed team|wrong account/i.test(error.message)
        ? "wrong_account"
        : error instanceof HttpError && /scope/i.test(error.message)
          ? "insufficient_scopes"
          : "callback_error",
    );
    const response = NextResponse.redirect(destination);
    response.headers.set("Cross-Origin-Opener-Policy", "unsafe-none");
    response.cookies.delete("reddone_vercel_state");
    return response;
  }
}
