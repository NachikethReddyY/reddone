import { randomUUID } from "node:crypto";

import { hashPassword } from "better-auth/crypto";

import { OwnerBootstrapInputSchema, hashSetupToken, verifySetupToken } from "@/server/auth";
import { ensurePromotionalGrant } from "@/server/credits";
import { getDb } from "@/server/db";
import { getRuntimeConfig, isDemoMode } from "@/server/env";
import { assertTrustedOrigin } from "@/server/security/request";
import { apiError, ok, requestId } from "@/workflows/http";

const attempts = new Map<string, { count: number; resetAt: number }>();

function assertRateLimit(request: Request) {
  const key = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  const current = Date.now();
  const item = attempts.get(key);
  if (!item || item.resetAt <= current) {
    attempts.set(key, { count: 1, resetAt: current + 15 * 60_000 });
    return;
  }
  if (item.count >= 5) throw new Error("Too many setup attempts. Try again after 15 minutes.");
  item.count += 1;
}

async function recordPersistentSetupAttempt(input: { expectedHash: string; valid: boolean; timeZone: string }) {
  const db = getDb();
  return db.$transaction(async (tx) => {
    let workspace = await tx.workspace.findFirst({ orderBy: { createdAt: "asc" } });
    workspace ??= await tx.workspace.create({
      data: { name: "ReDDone Private Workspace", timeZone: input.timeZone, maxConcurrentSandboxes: 2 },
    });
    let token = await tx.setupToken.findUnique({ where: { tokenHash: input.expectedHash } });
    token ??= await tx.setupToken.create({
      data: { workspaceId: workspace.id, tokenHash: input.expectedHash, expiresAt: new Date(Date.now() + 24 * 60 * 60_000) },
    });
    const now = new Date();
    if (token.lockedUntil && token.lockedUntil > now) throw new Error("Too many setup attempts. Try again after 15 minutes.");
    if (token.consumedAt || token.expiresAt <= now) return { allowed: false, tokenId: token.id };
    if (!input.valid) {
      const failures = token.failedAttempts + 1;
      await tx.setupToken.update({
        where: { id: token.id },
        data: { failedAttempts: failures, lockedUntil: failures >= 5 ? new Date(Date.now() + 15 * 60_000) : null },
      });
      return { allowed: false, tokenId: token.id };
    }
    return { allowed: true, tokenId: token.id };
  }, { isolationLevel: "Serializable", timeout: 10_000 });
}

export async function POST(request: Request) {
  const id = requestId(request);
  try {
    assertRateLimit(request);
    const config = getRuntimeConfig();
    assertTrustedOrigin(request.headers.get("origin"), config.auth.trustedOrigin);
    const idempotencyKey = request.headers.get("idempotency-key");
    if (!idempotencyKey || idempotencyKey.length < 8) return apiError(id, "precondition_required", "Idempotency-Key is required.", 428);
    const input = OwnerBootstrapInputSchema.parse(await request.json());
    if (isDemoMode()) {
      return ok({ created: false, demo: true, message: "Demo mode needs no owner account. Open the populated demo." }, id);
    }
    const expectedHash = config.auth.setupTokenHash;
    if (!expectedHash) return apiError(id, "feature_disabled", "Owner setup is not configured.", 503);
    const submittedHash = hashSetupToken(input.setupToken);
    const attempt = await recordPersistentSetupAttempt({
      expectedHash,
      valid: verifySetupToken(input.setupToken, expectedHash),
      timeZone: config.timeZone,
    });
    if (!attempt.allowed) {
      return apiError(id, "forbidden", "The setup token is invalid, expired, or already consumed.", 403);
    }
    const passwordHash = await hashPassword(input.password);
    const db = getDb();
    const owner = await db.$transaction(
      async (tx) => {
        if ((await tx.user.count()) > 0) throw new Error("Owner setup has already been completed.");
        let workspace = await tx.workspace.findFirst({ orderBy: { createdAt: "asc" } });
        if (!workspace) {
          workspace = await tx.workspace.create({
            data: { name: "ReDDone Private Workspace", timeZone: config.timeZone, maxConcurrentSandboxes: 2 },
          });
        }
        const token = await tx.setupToken.findUnique({ where: { id: attempt.tokenId } });
        if (!token) throw new Error("The setup token is unavailable.");
        if (
          token.workspaceId !== workspace.id ||
          token.tokenHash !== submittedHash ||
          token.consumedAt ||
          token.expiresAt <= new Date() ||
          (token.lockedUntil && token.lockedUntil > new Date())
        ) {
          throw new Error("The setup token is invalid, expired, or already consumed.");
        }
        const consumed = await tx.setupToken.updateMany({
          where: { id: token.id, consumedAt: null, expiresAt: { gt: new Date() } },
          data: { consumedAt: new Date() },
        });
        if (consumed.count !== 1) throw new Error("The setup token was consumed by another request.");
        const userId = randomUUID();
        const user = await tx.user.create({
          data: {
            id: userId,
            workspaceId: workspace.id,
            name: input.name,
            username: input.username,
            displayUsername: input.username,
            email: input.email,
            emailVerified: true,
          },
        });
        await tx.account.create({
          data: {
            id: randomUUID(),
            userId,
            accountId: userId,
            providerId: "credential",
            password: passwordHash,
          },
        });
        await ensurePromotionalGrant(tx, { workspaceId: workspace.id });
        return { userId: user.id, workspaceId: workspace.id, email: user.email };
      },
      { isolationLevel: "Serializable", timeout: 15_000 },
    );
    attempts.clear();
    return ok({ created: true, owner }, id, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Owner setup failed.";
    const status = /already|consumed/i.test(message) ? 409 : /too many/i.test(message) ? 429 : 400;
    return apiError(id, status === 409 ? "conflict" : status === 429 ? "rate_limited" : "bad_request", message, status, status === 429);
  }
}
