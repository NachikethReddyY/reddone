import { NextResponse } from "next/server";
import { z } from "zod";

import { hashHackathonCreditCode, normalizeHackathonCreditCode } from "@/server/credits";
import { getDb } from "@/server/db";
import { getRuntimeConfig } from "@/server/env";
import { HACKATHON_ADMISSION_COOKIE, issueHackathonAdmission, verifyHackathonRegistrationCode } from "@/server/hackathon-admission";
import { assertTrustedOrigin } from "@/server/security/request";
import { apiError, requestId } from "@/workflows/http";

const attempts = new Map<string, { count: number; resetAt: number }>();

function allowAttempt(request: Request) {
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  const current = Date.now();
  const existing = attempts.get(ip);
  if (!existing || existing.resetAt <= current) {
    attempts.set(ip, { count: 1, resetAt: current + 15 * 60_000 });
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
    if (config.deploymentMode !== "hackathon") return apiError(id, "feature_disabled", "Hackathon registration is unavailable.", 403);
    assertTrustedOrigin(request.headers.get("origin"), config.auth.trustedOrigin);
    if (!allowAttempt(request)) return apiError(id, "rate_limited", "Registration is temporarily unavailable. Try again later.", 429, true);
    const body = z.object({ code: z.string().min(12).max(512) }).strict().parse(await request.json());
    let creditCode: string | undefined;
    if (config.auth.registrationPepper) {
      const normalized = normalizeHackathonCreditCode(body.code);
      const record = await getDb().creditCode.findUnique({
        where: { codeHash: hashHackathonCreditCode(normalized, config.auth.registrationPepper) },
        select: { disabledAt: true, expiresAt: true, currentRedemptions: true, maxRedemptions: true },
      });
      if (record && !record.disabledAt && record.expiresAt > new Date() && record.currentRedemptions < record.maxRedemptions) {
        creditCode = normalized;
      }
    }
    if (!creditCode && !verifyHackathonRegistrationCode(body.code)) {
      return apiError(id, "forbidden", "Registration is unavailable.", 403);
    }
    const response = NextResponse.json({ data: { admitted: true }, requestId: id });
    response.cookies.set(HACKATHON_ADMISSION_COOKIE, issueHackathonAdmission(creditCode ? { creditCode } : {}), {
      httpOnly: true,
      secure: config.environment === "production",
      sameSite: "lax",
      path: "/api/auth",
      maxAge: 10 * 60,
    });
    return response;
  } catch {
    return apiError(id, "bad_request", "Registration is unavailable.", 400);
  }
}
