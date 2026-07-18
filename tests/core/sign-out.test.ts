import { afterEach, describe, expect, it, vi } from "vitest";

import { signOutOwnerSession } from "@/features/auth/sign-out";

afterEach(() => vi.unstubAllGlobals());

describe("owner sign out", () => {
  it("uses the application-owned sign-out endpoint and mutation contract", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: { success: true } }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await signOutOwnerSession();

    expect(fetchMock).toHaveBeenCalledWith("/api/v1/account/sign-out", expect.objectContaining({
      method: "POST",
      credentials: "same-origin",
      body: "{}",
      headers: expect.objectContaining({
        accept: "application/json",
        "content-type": "application/json",
        "idempotency-key": expect.stringMatching(/^sign-out-/),
      }),
    }));
  });

  it("surfaces unsuccessful sign-out responses to the caller", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 503 })));

    await expect(signOutOwnerSession()).rejects.toThrow("Sign out failed with status 503.");
  });
});
