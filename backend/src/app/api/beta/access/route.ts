import { NextResponse } from "next/server";
import { z } from "zod";

import { BETA_ADMISSION_COOKIE, issueBetaAdmission } from "@/server/beta-admission";
import { hashCreditCode, normalizeCreditCode } from "@/server/credit-codes";
import { getDb } from "@/server/db";
import { getRuntimeConfig } from "@/server/env";
import { assertTrustedOrigin } from "@/server/security/request";
import { apiError, requestId } from "@/workflows/http";

const attempts = new Map<string, { count: number; resetAt: number }>();

function allowAttempt(request: Request) {
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  const now = Date.now();
  const existing = attempts.get(ip);
  if (!existing || existing.resetAt <= now) {
    attempts.set(ip, { count: 1, resetAt: now + 15 * 60_000 });
    return true;
  }
  if (existing.count >= 6) return false;
  existing.count += 1;
  return true;
}

export async function POST(request: Request) {
  const id = requestId(request);
  try {
    const config = getRuntimeConfig();
    if (config.deploymentMode !== "public" || !config.auth.ownerAccessCodePepper) {
      return apiError(id, "feature_disabled", "Private beta access is not configured.", 503);
    }
    assertTrustedOrigin(request.headers.get("origin"), config.auth.trustedOrigin);
    if (!allowAttempt(request)) {
      return apiError(id, "rate_limited", "Too many invite attempts. Try again later.", 429, true);
    }
    const body = z.object({ code: z.string().min(12).max(512) }).strict().parse(await request.json());
    const code = normalizeCreditCode(body.code);
    const record = await getDb().creditCode.findUnique({
      where: { codeHash: hashCreditCode(code, config.auth.ownerAccessCodePepper) },
      select: { disabledAt: true, expiresAt: true, currentRedemptions: true, maxRedemptions: true },
    });
    if (!record || record.disabledAt || record.expiresAt <= new Date() || record.currentRedemptions >= record.maxRedemptions) {
      return apiError(id, "forbidden", "This invite is invalid, expired, or already used.", 403);
    }
    const response = NextResponse.json({ data: { admitted: true }, requestId: id });
    response.cookies.set(BETA_ADMISSION_COOKIE, issueBetaAdmission(code), {
      httpOnly: true,
      secure: config.environment === "production",
      sameSite: "lax",
      path: "/api/owner",
      maxAge: 15 * 60,
    });
    return response;
  } catch {
    return apiError(id, "bad_request", "Enter the complete invite code.", 400);
  }
}
