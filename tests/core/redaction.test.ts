import { describe, expect, it } from "vitest";

import {
  assertNoSecretLikeInput,
  containsSecretLikeText,
  containsSecretLikeValue,
  redactText,
  redactValue,
} from "@/server/security";
import { assertProjectRuntimeSecretNameAllowed } from "@/policy/secret-guard";

describe("secret redaction", () => {
  it("redacts common authorization and token forms", () => {
    const input = "Authorization: Bearer abcdefghijklmnop and api_key=sk-test_abcdefghijklmnop";
    const output = redactText(input);
    expect(output).toContain("[REDACTED]");
    expect(output).not.toContain("abcdefghijklmnop");
  });

  it("redacts values under sensitive keys at any depth", () => {
    const input = {
      provider: "kimi",
      nested: { clientSecret: "do-not-return", harmless: "visible" },
      list: [{ access_token: "also-private" }],
    };
    const output = redactValue(input) as typeof input;
    expect(output.nested.clientSecret).toBe("[REDACTED]");
    expect(output.nested.harmless).toBe("visible");
    expect(output.list[0]?.access_token).toBe("[REDACTED]");
    expect(containsSecretLikeValue(input)).toBe(true);
  });

  it("rejects secret-like chat input with a safe redirect", () => {
    expect(containsSecretLikeText("Here is my token: abcdefghijklmnop")).toBe(true);
    expect(() => assertNoSecretLikeInput("Here is my token: abcdefghijklmnop")).toThrow(/Connections/);
    expect(() => assertNoSecretLikeInput("Please make the empty state clearer")).not.toThrow();
  });

  it("keeps every signing key inside the control-plane boundary", () => {
    expect(() => assertProjectRuntimeSecretNameAllowed("VERIFICATION_SIGNING_KEY")).toThrow(/control-plane/i);
    expect(() => assertProjectRuntimeSecretNameAllowed("PREVIEW_SIGNING_KEY")).toThrow(/control-plane/i);
    expect(() => assertProjectRuntimeSecretNameAllowed("AIAND_API_KEY")).toThrow(/control-plane/i);
    expect(() => assertProjectRuntimeSecretNameAllowed("CUSTOMER_RESTRICTED_API_KEY")).not.toThrow();
  });
});
