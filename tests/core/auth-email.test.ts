import { afterEach, describe, expect, it, vi } from "vitest";

import { deliverAuthEmail } from "@/server/auth-email";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("authentication email delivery", () => {
  it("logs development delivery links when no provider is configured", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("APP_MODE", "demo");
    vi.stubEnv("AUTH_EMAIL_DELIVERY_MODE", "log");
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);

    await deliverAuthEmail({
      kind: "verification",
      to: "owner@example.test",
      name: "Owner",
      url: "https://console.example.test/api/auth/verify-email?token=development-token",
    });

    expect(info).toHaveBeenCalledWith("[auth-email]", expect.stringContaining("development-token"));
  });

  it("delivers verification and reset payloads through the configured webhook boundary", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("APP_MODE", "demo");
    vi.stubEnv("AUTH_EMAIL_DELIVERY_MODE", "webhook");
    vi.stubEnv("AUTH_EMAIL_FROM", "ReDDone <no-reply@example.test>");
    vi.stubEnv("AUTH_EMAIL_WEBHOOK_URL", "https://email.example.test/send");
    vi.stubEnv("AUTH_EMAIL_WEBHOOK_TOKEN", "e".repeat(32));
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);

    await deliverAuthEmail({
      kind: "password-reset",
      to: "owner@example.test",
      url: "https://console.example.test/api/auth/reset-password/token",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://email.example.test/send");
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${"e".repeat(32)}`);
    expect(JSON.parse(String(init.body))).toMatchObject({
      category: "auth.password-reset",
      from: "ReDDone <no-reply@example.test>",
      to: "owner@example.test",
      subject: "Reset password",
    });
  });
});
