import { ZodError } from "zod";

import { BETA_ADMISSION_COOKIE, readBetaAdmission, readRequestCookie } from "@/server/beta-admission";
import { getRuntimeConfig } from "@/server/env";
import { AppError } from "@/server/errors";
import { OwnerAccessRegistrationSchema, registerOwnerWithAccessCode } from "@/server/owner-access";
import { assertTrustedOrigin } from "@/server/security/request";
import { apiError, ok, requestId } from "@/workflows/http";

const attempts = new Map<string, { count: number; resetAt: number }>();

function allowAttempt(request: Request) {
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  const now = Date.now();
  const existing = attempts.get(ip);
  if (!existing || existing.resetAt <= now) {
    attempts.set(ip, { count: 1, resetAt: now + 15 * 60_000 });
    return true;
  }
  if (existing.count >= 5) return false;
  existing.count += 1;
  return true;
}

export async function POST(request: Request) {
  const id = requestId(request);
  try {
    const config = getRuntimeConfig();
    if (config.deploymentMode !== "public" || !config.auth.ownerAccessCodePepper) {
      return apiError(id, "feature_disabled", "Owner access is not configured.", 503);
    }
    assertTrustedOrigin(request.headers.get("origin"), config.auth.trustedOrigin);
    if (!allowAttempt(request)) {
      return apiError(id, "rate_limited", "Owner access is temporarily unavailable. Try again later.", 429, true);
    }
    const body = await request.json() as Record<string, unknown>;
    const admission = readBetaAdmission(readRequestCookie(request.headers.get("cookie"), BETA_ADMISSION_COOKIE));
    const input = OwnerAccessRegistrationSchema.parse({ ...body, code: admission?.code ?? body.code });
    const ipAddress = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
    const result = await registerOwnerWithAccessCode({
      ...input,
      requestId: id,
      ...(ipAddress ? { ipAddress } : {}),
    });
    const response = ok(result, id, { status: 201 });
    response.cookies.set(BETA_ADMISSION_COOKIE, "", {
      httpOnly: true,
      secure: config.environment === "production",
      sameSite: "lax",
      path: "/api/owner",
      maxAge: 0,
    });
    return response;
  } catch (error) {
    if (error instanceof ZodError) return apiError(id, "bad_request", "Review the owner details and access code.", 400);
    if (error instanceof AppError) return apiError(id, error.code, error.message, error.status, error.retryable);
    return apiError(id, "internal_error", "Owner access could not be completed.", 500, true);
  }
}
