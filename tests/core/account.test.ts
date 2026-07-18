import { describe, expect, it } from "vitest";

import {
  AccountSessionSchema,
  AccountUpdateInputSchema,
  ChangePasswordInputSchema,
} from "@/contracts/account";
import { assertValidTimeZone, maskIpAddress } from "@/server/account";

describe("account contracts and redaction", () => {
  it("masks IPv4 and IPv6 addresses without returning the original address", () => {
    expect(maskIpAddress("203.0.113.42")).toBe("203.0.113.xxx");
    expect(maskIpAddress("2001:db8:85a3::8a2e:370:7334")).toBe("2001:db8:85a3:…");
    expect(maskIpAddress("untrusted-forwarded-value")).toBe("masked");
  });

  it("uses strict public session records that reject tokens", () => {
    const base = {
      id: "session-1",
      current: true,
      ipAddress: "203.0.113.xxx",
      userAgent: "Browser",
      createdAt: "2026-07-17T00:00:00.000Z",
      updatedAt: "2026-07-17T01:00:00.000Z",
      expiresAt: "2026-07-31T00:00:00.000Z",
    };
    expect(AccountSessionSchema.parse(base)).toEqual(base);
    expect(() => AccountSessionSchema.parse({ ...base, token: "secret-session-token" })).toThrow();
  });

  it("requires intentional account updates and strong password changes", () => {
    expect(() => AccountUpdateInputSchema.parse({})).toThrow();
    expect(AccountUpdateInputSchema.parse({ workspaceName: "Product studio", timeZone: "Asia/Singapore" })).toEqual({
      workspaceName: "Product studio",
      timeZone: "Asia/Singapore",
    });
    expect(() => ChangePasswordInputSchema.parse({ currentPassword: "old", newPassword: "too-short" })).toThrow();
  });

  it("validates IANA time zones", () => {
    expect(() => assertValidTimeZone("America/New_York")).not.toThrow();
    expect(() => assertValidTimeZone("Mars/Olympus_Mons")).toThrow(/IANA/i);
  });
});
