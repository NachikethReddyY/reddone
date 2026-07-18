import { createHmac, timingSafeEqual } from "node:crypto";

export function verifySha256Webhook(input: { body: string; signature: string | null; secret: string | undefined }) {
  if (!input.secret || !input.signature) return false;
  const normalized = input.signature.startsWith("sha256=") ? input.signature.slice(7) : input.signature;
  const expected = createHmac("sha256", input.secret).update(input.body).digest("hex");
  const suppliedBuffer = Buffer.from(normalized);
  const expectedBuffer = Buffer.from(expected);
  return suppliedBuffer.length === expectedBuffer.length && timingSafeEqual(suppliedBuffer, expectedBuffer);
}

export function verifySha1Webhook(input: { body: string; signature: string | null; secret: string | undefined }) {
  if (!input.secret || !input.signature) return false;
  const expected = createHmac("sha1", input.secret).update(input.body).digest("hex");
  const suppliedBuffer = Buffer.from(input.signature.trim());
  const expectedBuffer = Buffer.from(expected);
  return suppliedBuffer.length === expectedBuffer.length && timingSafeEqual(suppliedBuffer, expectedBuffer);
}
