import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { assertTrustedOrigin, getRuntimeConfig, registerOwnerWithAccessCode } = vi.hoisted(() => ({
  assertTrustedOrigin: vi.fn(),
  getRuntimeConfig: vi.fn(),
  registerOwnerWithAccessCode: vi.fn(),
}));

vi.mock("@/server/env", () => ({ getRuntimeConfig }));
vi.mock("@/server/security/request", () => ({ assertTrustedOrigin }));
vi.mock("@/server/owner-access", async () => {
  const { z } = await import("zod");
  return {
    OwnerAccessRegistrationSchema: z.object({
      code: z.string().min(12).max(512),
      name: z.string().trim().min(2).max(120),
      username: z.string().trim().toLowerCase().min(3).max(30).regex(/^[a-z0-9_.]+$/),
      email: z.string().trim().toLowerCase().email().max(320),
      password: z.string().min(12).max(200),
    }).strict(),
    registerOwnerWithAccessCode,
  };
});

import { POST } from "@/app/api/owner/register/route";

describe("owner access registration route", () => {
  beforeEach(() => {
    getRuntimeConfig.mockReturnValue({
      deploymentMode: "public",
      auth: { ownerAccessCodePepper: "p".repeat(48), trustedOrigin: "https://console.example.test" },
    });
    registerOwnerWithAccessCode.mockResolvedValue({
      created: true,
      userId: "user-1",
      workspaceId: "workspace-1",
      email: "owner@example.test",
      emailVerified: true,
      grantCredits: 1_000_000n,
    });
  });

  afterEach(() => vi.clearAllMocks());

  it("validates origin and registers a normalized owner without echoing the code", async () => {
    const response = await POST(new Request("https://console.example.test/api/owner/register", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://console.example.test",
        "x-forwarded-for": "203.0.113.7",
        "x-request-id": "owner-request-1",
      },
      body: JSON.stringify({
        code: "OWNER-ABCDEF-123456",
        name: "Nora",
        username: "Nora.Dev",
        email: "OWNER@EXAMPLE.TEST",
        password: "correct horse battery staple",
      }),
    }));

    expect(response.status).toBe(201);
    expect(assertTrustedOrigin).toHaveBeenCalledWith("https://console.example.test", "https://console.example.test");
    expect(registerOwnerWithAccessCode).toHaveBeenCalledWith(expect.objectContaining({
      code: "OWNER-ABCDEF-123456",
      username: "nora.dev",
      email: "owner@example.test",
      requestId: "owner-request-1",
      ipAddress: "203.0.113.7",
    }));
    const payload = await response.json();
    expect(payload.data).toMatchObject({ emailVerified: true, grantCredits: "1000000" });
    expect(JSON.stringify(payload)).not.toContain("OWNER-ABCDEF-123456");
  });

  it("fails closed when owner access is not configured", async () => {
    getRuntimeConfig.mockReturnValue({
      deploymentMode: "public",
      auth: { ownerAccessCodePepper: null, trustedOrigin: "https://console.example.test" },
    });
    const response = await POST(new Request("https://console.example.test/api/owner/register", {
      method: "POST",
      headers: { origin: "https://console.example.test" },
      body: "{}",
    }));

    expect(response.status).toBe(503);
    expect(registerOwnerWithAccessCode).not.toHaveBeenCalled();
  });

  it("rejects unexpected registration fields before account creation", async () => {
    const response = await POST(new Request("https://console.example.test/api/owner/register", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://console.example.test" },
      body: JSON.stringify({
        code: "OWNER-ABCDEF-123456",
        name: "Nora",
        username: "nora",
        email: "owner@example.test",
        password: "correct horse battery staple",
        role: "admin",
      }),
    }));

    expect(response.status).toBe(400);
    expect(registerOwnerWithAccessCode).not.toHaveBeenCalled();
  });
});
