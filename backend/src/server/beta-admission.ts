import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { z } from "zod";

import { normalizeCreditCode } from "./credit-codes";
import { getRuntimeConfig } from "./env";

export const BETA_ADMISSION_COOKIE = "reddone_beta_admission";

const BetaAdmissionSchema = z.object({
  code: z.string().min(12).max(128),
  expiresAt: z.number().int().positive(),
  nonce: z.string().regex(/^[a-f0-9]{32}$/),
}).strict();

function safeEqual(left: Buffer, right: Buffer) {
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}

export function issueBetaAdmission(code: string, now = Date.now()) {
  const config = getRuntimeConfig();
  if (config.deploymentMode !== "public" || !config.auth.ownerAccessCodePepper) {
    throw new Error("Private beta access is unavailable");
  }
  const payload = BetaAdmissionSchema.parse({
    code: normalizeCreditCode(code),
    expiresAt: now + 15 * 60_000,
    nonce: randomBytes(16).toString("hex"),
  });
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = createHmac("sha256", config.auth.ownerAccessCodePepper).update(encoded, "utf8").digest("base64url");
  return `${encoded}.${signature}`;
}

export function readBetaAdmission(value: string | null | undefined, now = Date.now()) {
  const config = getRuntimeConfig();
  if (config.deploymentMode !== "public" || !value || !config.auth.ownerAccessCodePepper) return null;
  const [encoded, signature, extra] = value.split(".");
  if (!encoded || !signature || extra) return null;
  const expected = createHmac("sha256", config.auth.ownerAccessCodePepper).update(encoded, "utf8").digest("base64url");
  if (!safeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  try {
    const payload = BetaAdmissionSchema.parse(JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")));
    return payload.expiresAt > now ? payload : null;
  } catch {
    return null;
  }
}

export function readRequestCookie(header: string | null, name: string) {
  if (!header) return null;
  const value = header.split(/;\s*/).find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1);
  return value ? decodeURIComponent(value) : null;
}
