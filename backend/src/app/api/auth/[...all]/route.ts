import { toNextJsHandler } from "better-auth/next-js";

import { getAuth } from "@/server/better-auth";
import { isDemoMode, isHackathonMode } from "@/server/env";
import { hasHackathonAdmission, isHackathonGitHubOAuthRequest } from "@/server/hackathon-admission";

async function handler(request: Request) {
  if (isDemoMode()) {
    return Response.json(
      { error: { code: "feature_disabled", message: "Authentication is bypassed in clearly labeled demo mode." } },
      { status: 503 },
    );
  }
  if (isHackathonMode() && isHackathonGitHubOAuthRequest(request) && !hasHackathonAdmission(request)) {
    return Response.json(
      { error: { code: "forbidden", message: "A valid hackathon registration code is required before GitHub sign-in." } },
      { status: 403 },
    );
  }
  return toNextJsHandler(getAuth())[request.method as "GET" | "POST" | "PATCH" | "PUT" | "DELETE"](request);
}

export const GET = handler;
export const POST = handler;
export const PATCH = handler;
export const PUT = handler;
export const DELETE = handler;
