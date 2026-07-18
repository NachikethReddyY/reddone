import { describe, expect, it } from "vitest";

import { safeReturnTo, validateReturnTo } from "@/policy/return-to";

describe("return path validation", () => {
  it("preserves safe application paths and query strings", () => {
    expect(validateReturnTo("/projects/one?tab=builds&from=approval")).toBe(
      "/projects/one?tab=builds&from=approval",
    );
  });

  it.each([
    "https://evil.example/path",
    "//evil.example/path",
    "/\\evil.example/path",
    "/%5Cevil.example/path",
    "/%5cevil.example/path",
    "/..//evil.example/path",
    "/%2e%2e//evil.example/path",
    "javascript:alert(1)",
    " /projects",
    "/projects\nnext",
  ])("rejects unsafe return path %s", (value) => {
    expect(validateReturnTo(value)).toBeNull();
  });

  it("uses a safe fallback when the requested path is invalid", () => {
    expect(safeReturnTo("//evil.example", "/account?section=sessions")).toBe(
      "/account?section=sessions",
    );
  });
});
