import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getOwnerSession: vi.fn(),
  headers: vi.fn(),
  isDemoMode: vi.fn(),
  redirect: vi.fn(),
}));

vi.mock("next/headers", () => ({ headers: mocks.headers }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("@/server/better-auth", () => ({ getOwnerSession: mocks.getOwnerSession }));
vi.mock("@/server/env", () => ({ isDemoMode: mocks.isDemoMode }));

import ConsoleLayout from "@/app/(console)/layout";

describe("console layout authentication", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.headers.mockResolvedValue(new Headers({ cookie: "__Secure-reddone.session_token=stale" }));
    mocks.isDemoMode.mockReturnValue(false);
    mocks.redirect.mockImplementation((location: string) => {
      throw new Error(`redirect:${location}`);
    });
  });

  it("redirects a stale or invalid session before rendering the console", async () => {
    mocks.getOwnerSession.mockResolvedValue(null);

    await expect(ConsoleLayout({ children: null })).rejects.toThrow("redirect:/sign-in?returnTo=%2Fprojects");
    expect(mocks.getOwnerSession).toHaveBeenCalledOnce();
  });

  it("does not query Better Auth while rendering the local product demo", async () => {
    mocks.isDemoMode.mockReturnValue(true);

    await ConsoleLayout({ children: null });

    expect(mocks.getOwnerSession).not.toHaveBeenCalled();
    expect(mocks.redirect).not.toHaveBeenCalled();
  });
});
