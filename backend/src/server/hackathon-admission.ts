import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { z } from "zod";

import { getRuntimeConfig } from "./env";

export const HACKATHON_ADMISSION_COOKIE = "reddone_hackathon_admission";
const AdmissionPayloadSchema = z.object({
  expiresAt: z.number().int().positive(),
  nonce: z.string().regex(/^[a-f0-9]{32}$/),
  creditCode: z.string().min(12).max(128).optional(),
}).strict();

/**
 * These are the only Better Auth endpoints that can start or complete a
 * hackathon participant's GitHub identity flow. Keeping this narrow avoids
 * accidentally placing an admission-code requirement on session management
 * and sign-out routes.
 */
const HACKATHON_GITHUB_OAUTH_PATHS = new Set([
  "/api/auth/sign-in/social",
  "/api/auth/callback/github",
]);

function mac(value: string, pepper: string) {
  return createHmac("sha256", pepper).update(value, "utf8").digest();
}

function safeEqual(left: Buffer, right: Buffer) {
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}

export function verifyHackathonRegistrationCode(candidate: string) {
  const config = getRuntimeConfig();
  if (config.deploymentMode !== "hackathon" || !config.auth.registrationCode || !config.auth.registrationPepper) return false;
  return safeEqual(mac(candidate.trim(), config.auth.registrationPepper), mac(config.auth.registrationCode, config.auth.registrationPepper));
}

export function issueHackathonAdmission(input: number | { creditCode?: string; now?: number } = {}) {
  const config = getRuntimeConfig();
  if (config.deploymentMode !== "hackathon" || !config.auth.registrationPepper) {
    throw new Error("Hackathon registration is unavailable");
  }
  const options = typeof input === "number" ? { now: input } : input;
  const now = options.now ?? Date.now();
  const payload = AdmissionPayloadSchema.parse({
    expiresAt: now + 10 * 60_000,
    nonce: randomBytes(16).toString("hex"),
    ...(options.creditCode ? { creditCode: options.creditCode } : {}),
  });
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = createHmac("sha256", config.auth.registrationPepper).update(encoded, "utf8").digest("base64url");
  return `${encoded}.${signature}`;
}

export function readHackathonAdmission(value: string | null | undefined, now = Date.now()) {
  const config = getRuntimeConfig();
  if (config.deploymentMode !== "hackathon" || !value || !config.auth.registrationPepper) return null;
  const [encoded, signature, extra] = value.split(".");
  if (!encoded || !signature || extra) return null;
  const expected = createHmac("sha256", config.auth.registrationPepper).update(encoded, "utf8").digest("base64url");
  if (!safeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  try {
    const payload = AdmissionPayloadSchema.parse(JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")));
    return payload.expiresAt > now ? payload : null;
  } catch {
    return null;
  }
}

export function verifyHackathonAdmission(value: string | null | undefined, now = Date.now()) {
  return readHackathonAdmission(value, now) !== null;
}

export function readCookie(header: string | null, name: string) {
  if (!header) return null;
  const value = header.split(/;\s*/).find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1);
  return value ? decodeURIComponent(value) : null;
}

/** True only for the GitHub OAuth start and callback endpoints in hackathon mode. */
export function isHackathonGitHubOAuthRequest(request: Pick<Request, "url">) {
  try {
    return HACKATHON_GITHUB_OAUTH_PATHS.has(new URL(request.url).pathname);
  } catch {
    return false;
  }
}

/**
 * Checks the signed, HTTP-only admission cookie at the server boundary.
 * The database hook remains the final guard before a participant user and
 * workspace are created.
 */
export function hasHackathonAdmission(request: Pick<Request, "headers">) {
  return verifyHackathonAdmission(readCookie(request.headers.get("cookie"), HACKATHON_ADMISSION_COOKIE));
}
