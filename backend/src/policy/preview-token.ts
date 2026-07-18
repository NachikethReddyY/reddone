import { createHmac, timingSafeEqual } from "node:crypto";

import { z } from "zod";

export const PreviewTokenPayloadSchema = z
  .object({
    version: z.literal(1),
    mode: z.enum(["demo", "live"]),
    artifactId: z.string().trim().min(1).max(128),
    artifactHash: z.string().regex(/^[a-f0-9]{64}$/i),
    issuedAt: z.number().int().nonnegative(),
    expiresAt: z.number().int().positive(),
  })
  .strict();

export type PreviewTokenPayload = z.infer<typeof PreviewTokenPayloadSchema>;

function signature(encodedPayload: string, key: string) {
  if (Buffer.byteLength(key) < 32) throw new Error("Preview signing key must contain at least 32 bytes.");
  return createHmac("sha256", key).update(encodedPayload).digest();
}

export function signPreviewToken(input: {
  mode: PreviewTokenPayload["mode"];
  artifactId: string;
  artifactHash: string;
  key: string;
  now?: Date;
  ttlSeconds?: number;
}) {
  const issuedAt = Math.floor((input.now ?? new Date()).getTime() / 1_000);
  const ttlSeconds = Math.min(Math.max(input.ttlSeconds ?? 900, 30), 3_600);
  const payload = PreviewTokenPayloadSchema.parse({
    version: 1,
    mode: input.mode,
    artifactId: input.artifactId,
    artifactHash: input.artifactHash,
    issuedAt,
    expiresAt: issuedAt + ttlSeconds,
  });
  const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${encodedPayload}.${signature(encodedPayload, input.key).toString("base64url")}`;
}

export function verifyPreviewToken(input: {
  token: string;
  key: string;
  artifactId: string;
  expectedMode: PreviewTokenPayload["mode"];
  now?: Date;
}) {
  if (input.token.length > 4_096) throw new Error("Preview token is invalid.");
  const parts = input.token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw new Error("Preview token is invalid.");
  const expected = signature(parts[0], input.key);
  const supplied = Buffer.from(parts[1], "base64url");
  if (supplied.byteLength !== expected.byteLength || !timingSafeEqual(supplied, expected)) {
    throw new Error("Preview token is invalid.");
  }
  const decoded = Buffer.from(parts[0], "base64url");
  if (decoded.byteLength > 2_048) throw new Error("Preview token is invalid.");
  const payload = PreviewTokenPayloadSchema.parse(JSON.parse(decoded.toString("utf8")));
  const now = Math.floor((input.now ?? new Date()).getTime() / 1_000);
  if (
    payload.mode !== input.expectedMode ||
    payload.artifactId !== input.artifactId ||
    payload.issuedAt > now + 60 ||
    payload.expiresAt <= now ||
    payload.expiresAt <= payload.issuedAt ||
    payload.expiresAt - payload.issuedAt > 3_600
  ) {
    throw new Error("Preview token is invalid or expired.");
  }
  return payload;
}
