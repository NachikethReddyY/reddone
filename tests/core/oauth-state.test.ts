import { afterEach, describe, expect, it, vi } from "vitest";

import { createOAuthState, verifyOAuthState } from "@/policy/oauth-state";

afterEach(() => vi.unstubAllEnvs());

describe("OAuth state return paths", () => {
  it("preserves safe relative paths and rejects external redirect forms", () => {
    vi.stubEnv("BETTER_AUTH_SECRET", "oauth-state-test-secret".padEnd(32, "x"));

    const safe = createOAuthState("vercel", "/connections?provider=vercel#status");
    expect(safe.payload.returnTo).toBe("/connections?provider=vercel#status");
    expect(verifyOAuthState(safe.state, "vercel").returnTo).toBe("/connections?provider=vercel#status");

    for (const returnTo of ["/usage?granularity=week", "/payments"]) {
      const created = createOAuthState("github", returnTo);
      expect(created.payload.returnTo).toBe(returnTo);
      expect(verifyOAuthState(created.state, "github").returnTo).toBe(returnTo);
    }

    const longSafePath = `/${"a".repeat(700)}`;
    const longSafe = createOAuthState("vercel", longSafePath);
    expect(verifyOAuthState(longSafe.state, "vercel").returnTo).toBe(longSafePath);

    for (const unsafe of [
      "//evil.example",
      "/\\evil.example",
      "https://evil.example",
      "/%5Cevil.example",
      "/..//evil.example",
      "/%2e%2e//evil.example",
    ]) {
      const created = createOAuthState("github", unsafe);
      expect(created.payload.returnTo).toBe("/connections");
      expect(verifyOAuthState(created.state, "github").returnTo).toBe("/connections");
    }
  });
});
