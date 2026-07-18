import { createHash, timingSafeEqual } from "node:crypto";

import { z } from "zod";

import { AppError } from "./errors";

export const OwnerBootstrapInputSchema = z
  .object({
    setupToken: z.string().min(32).max(512),
    name: z.string().trim().min(2).max(120),
    email: z.string().trim().toLowerCase().email().max(320),
    password: z.string().min(12).max(200),
  })
  .strict();

export interface OwnerContext {
  userId: string;
  workspaceId: string;
  email: string;
  role: "owner";
}

export interface SessionLike {
  user?: {
    id?: string | null;
    workspaceId?: string | null;
    email?: string | null;
  } | null;
}

export interface SetupAttemptState {
  failedAttempts: number;
  lockedUntil: Date | null;
}

export interface SetupAttemptResult extends SetupAttemptState {
  allowed: boolean;
}

export interface OwnerBootstrapRepository {
  /** Must consume the token and create the sole owner in one serializable transaction. */
  consumeTokenAndCreateOwner(input: {
    setupTokenHash: string;
    name: string;
    email: string;
    password: string;
  }): Promise<OwnerContext | null>;
}

export function hashSetupToken(token: string): string {
  if (token.length < 32) throw new AppError("bad_request", "The setup token is invalid");
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function verifySetupToken(token: string, expectedHash: string): boolean {
  if (!/^[a-f0-9]{64}$/i.test(expectedHash) || token.length < 32) return false;
  const actual = Buffer.from(hashSetupToken(token), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function recordSetupAttempt(
  state: SetupAttemptState,
  succeeded: boolean,
  now = new Date(),
  maximumAttempts = 5,
  lockDurationMs = 15 * 60_000,
): SetupAttemptResult {
  if (state.lockedUntil && state.lockedUntil.getTime() > now.getTime()) {
    return { ...state, allowed: false };
  }
  if (succeeded) return { failedAttempts: 0, lockedUntil: null, allowed: true };

  const failedAttempts = state.failedAttempts + 1;
  return {
    failedAttempts,
    lockedUntil: failedAttempts >= maximumAttempts ? new Date(now.getTime() + lockDurationMs) : null,
    allowed: failedAttempts < maximumAttempts,
  };
}

export function requireOwnerContext(session: SessionLike | null | undefined): OwnerContext {
  const user = session?.user;
  if (!user?.id || !user.workspaceId || !user.email) {
    throw new AppError("unauthenticated", "Sign in is required");
  }
  return { userId: user.id, workspaceId: user.workspaceId, email: user.email, role: "owner" };
}

export function createDemoOwnerContext(): OwnerContext {
  return {
    userId: "demo-owner",
    workspaceId: "demo-workspace",
    email: "owner@demo.invalid",
    role: "owner",
  };
}

export async function bootstrapOwner(
  input: z.input<typeof OwnerBootstrapInputSchema>,
  repository: OwnerBootstrapRepository,
): Promise<OwnerContext> {
  const parsed = OwnerBootstrapInputSchema.parse(input);
  const owner = await repository.consumeTokenAndCreateOwner({
    setupTokenHash: hashSetupToken(parsed.setupToken),
    name: parsed.name,
    email: parsed.email,
    password: parsed.password,
  });
  if (!owner) {
    throw new AppError("conflict", "Owner setup is unavailable or the setup token has already been consumed");
  }
  return owner;
}
