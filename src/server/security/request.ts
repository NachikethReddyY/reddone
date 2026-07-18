import { createHmac, timingSafeEqual } from "node:crypto";

import { AppError } from "../errors";

export function constantTimeEqual(left: string, right: string): boolean {
  const leftDigest = createHmac("sha256", "reddone-constant-time").update(left).digest();
  const rightDigest = createHmac("sha256", "reddone-constant-time").update(right).digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

export function signWebhookPayload(body: string | Uint8Array, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

export function verifyWebhookSignature(body: string | Uint8Array, signature: string | null, secret: string): boolean {
  if (!signature || secret.length < 16) return false;
  return constantTimeEqual(signWebhookPayload(body, secret), signature.trim());
}

export function assertTrustedOrigin(origin: string | null, trustedOrigin: string): void {
  if (!origin) throw new AppError("forbidden", "A trusted request origin is required");
  let actual: URL;
  let expected: URL;
  try {
    actual = new URL(origin);
    expected = new URL(trustedOrigin);
  } catch {
    throw new AppError("forbidden", "The request origin is invalid");
  }
  if (actual.origin !== expected.origin) throw new AppError("forbidden", "The request origin is not trusted");
}

