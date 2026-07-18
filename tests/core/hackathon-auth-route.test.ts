import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getAuth: vi.fn(),
  hasAdmission: vi.fn(),
  isDemoMode: vi.fn(),
  isHackathonMode: vi.fn(),
  isGitHubOAuthRequest: vi.fn(),
  oauthHandler: vi.fn(),
  toNextJsHandler: vi.fn(),
}));

vi.mock("@/server/better-auth", () => ({ getAuth: mocks.getAuth }));
vi.mock("@/server/env", () => ({
  isDemoMode: mocks.isDemoMode,
  isHackathonMode: mocks.isHackathonMode,
}));
vi.mock("@/server/hackathon-admission", () => ({
  hasHackathonAdmission: mocks.hasAdmission,
  isHackathonGitHubOAuthRequest: mocks.isGitHubOAuthRequest,
}));
vi.mock("better-auth/next-js", () => ({ toNextJsHandler: mocks.toNextJsHandler }));

import { POST } from "@/app/api/auth/[...all]/route";

describe("hackathon GitHub OAuth route guard", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.isDemoMode.mockReturnValue(false);
    mocks.isHackathonMode.mockReturnValue(true);
    mocks.isGitHubOAuthRequest.mockReturnValue(true);
    mocks.hasAdmission.mockReturnValue(false);
    mocks.oauthHandler.mockResolvedValue(new Response(null, { status: 204 }));
    mocks.toNextJsHandler.mockReturnValue({ POST: mocks.oauthHandler });
  });

  it("rejects a direct GitHub sign-in request without a valid admission", async () => {
    const response = await POST(new Request("https://console.example.test/api/auth/sign-in/social", { method: "POST" }));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: { code: "forbidden", message: "A valid hackathon registration code is required before GitHub sign-in." },
    });
    expect(mocks.getAuth).not.toHaveBeenCalled();
    expect(mocks.oauthHandler).not.toHaveBeenCalled();
  });

  it("forwards an admitted OAuth request to Better Auth", async () => {
    mocks.hasAdmission.mockReturnValue(true);
    const request = new Request("https://console.example.test/api/auth/sign-in/social", { method: "POST" });

    const response = await POST(request);

    expect(response.status).toBe(204);
    expect(mocks.getAuth).toHaveBeenCalledOnce();
    expect(mocks.oauthHandler).toHaveBeenCalledWith(request);
  });

  it("does not change private-mode authentication", async () => {
    mocks.isHackathonMode.mockReturnValue(false);
    const request = new Request("https://console.example.test/api/auth/sign-in/email", { method: "POST" });

    const response = await POST(request);

    expect(response.status).toBe(204);
    expect(mocks.oauthHandler).toHaveBeenCalledWith(request);
  });
});
