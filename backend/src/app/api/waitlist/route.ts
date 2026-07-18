import { createHash } from "node:crypto";

import { z } from "zod";

import { getDb } from "@/server/db";
import { getRuntimeConfig } from "@/server/env";
import { assertTrustedOrigin } from "@/server/security/request";
import { apiError, ok, requestId } from "@/workflows/http";

const WaitlistInputSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(320),
  source: z.string().trim().min(1).max(80).default("beta-page"),
  website: z.string().max(200).default(""),
}).strict();

const attempts = new Map<string, { count: number; resetAt: number }>();

function allowAttempt(request: Request) {
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  const key = createHash("sha256").update(ip).digest("hex");
  const now = Date.now();
  const existing = attempts.get(key);
  if (!existing || existing.resetAt <= now) {
    attempts.set(key, { count: 1, resetAt: now + 15 * 60_000 });
    return true;
  }
  if (existing.count >= 8) return false;
  existing.count += 1;
  return true;
}

export async function POST(request: Request) {
  const id = requestId(request);
  try {
    const config = getRuntimeConfig();
    assertTrustedOrigin(request.headers.get("origin"), config.auth.trustedOrigin);
    if (!allowAttempt(request)) return apiError(id, "rate_limited", "Too many requests. Try again later.", 429, true);
    const input = WaitlistInputSchema.parse(await request.json());
    if (input.website) return ok({ joined: true }, id, { status: 201 });
    if (!config.database) return apiError(id, "feature_disabled", "The waitlist is not connected yet.", 503, true);
    await getDb().waitlistEntry.upsert({
      where: { email: input.email },
      create: { email: input.email, source: input.source },
      update: { source: input.source, requestCount: { increment: 1 }, lastRequestedAt: new Date() },
    });
    return ok({ joined: true }, id, { status: 201 });
  } catch (error) {
    if (error instanceof z.ZodError) return apiError(id, "bad_request", "Enter a valid email address.", 400);
    return apiError(id, "internal_error", "The waitlist could not be updated. Try again.", 500, true);
  }
}
