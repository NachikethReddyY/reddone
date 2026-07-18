import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { z } from "zod";

import { MAX_RETURN_TO_LENGTH, safeReturnTo } from "./return-to";

const oauthStateSchema = z.object({
  provider: z.enum(["github", "vercel"]),
  nonce: z.string().min(16),
  returnTo: z.string().startsWith("/").max(MAX_RETURN_TO_LENGTH),
  issuedAt: z.number().int(),
  expiresAt: z.number().int(),
});

export type OAuthState = z.infer<typeof oauthStateSchema>;

function signingKey() {
  const value = process.env.BETTER_AUTH_SECRET;
  if (!value || value.length < 32) throw new Error("BETTER_AUTH_SECRET must be configured for OAuth state signing.");
  return value;
}

export function createOAuthState(provider: OAuthState["provider"], returnTo = "/connections") {
  const issuedAt = Date.now();
  const payload: OAuthState = {
    provider,
    nonce: randomBytes(24).toString("base64url"),
    returnTo: safeReturnTo(returnTo, "/connections"),
    issuedAt,
    expiresAt: issuedAt + 10 * 60_000,
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", signingKey()).update(encoded).digest("base64url");
  return { state: `${encoded}.${signature}`, payload };
}

export function verifyOAuthState(value: string, expectedProvider: OAuthState["provider"]) {
  const [encoded, suppliedSignature, extra] = value.split(".");
  if (!encoded || !suppliedSignature || extra) throw new Error("Invalid OAuth state.");
  const expectedSignature = createHmac("sha256", signingKey()).update(encoded).digest("base64url");
  const supplied = Buffer.from(suppliedSignature);
  const expected = Buffer.from(expectedSignature);
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new Error("OAuth state signature mismatch.");
  const parsed = oauthStateSchema.parse(JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")));
  if (parsed.provider !== expectedProvider) throw new Error("OAuth provider mismatch.");
  if (parsed.expiresAt < Date.now()) throw new Error("OAuth state expired.");
  return { ...parsed, returnTo: safeReturnTo(parsed.returnTo, "/connections") };
}
