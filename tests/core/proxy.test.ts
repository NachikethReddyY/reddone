import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";

import { proxy } from "@/proxy";

const previousAppMode = process.env.APP_MODE;
const previousAppUrl = process.env.NEXT_PUBLIC_APP_URL;
const previousPreviewOrigin = process.env.PREVIEW_ORIGIN;

describe("route protection", () => {
  beforeEach(() => {
    process.env.APP_MODE = "private";
    process.env.NEXT_PUBLIC_APP_URL = "https://reddone.example.test";
    process.env.PREVIEW_ORIGIN = "https://preview.example.test";
  });

  afterEach(() => {
    if (previousAppMode === undefined) delete process.env.APP_MODE;
    else process.env.APP_MODE = previousAppMode;
    if (previousAppUrl === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
    else process.env.NEXT_PUBLIC_APP_URL = previousAppUrl;
    if (previousPreviewOrigin === undefined) delete process.env.PREVIEW_ORIGIN;
    else process.env.PREVIEW_ORIGIN = previousPreviewOrigin;
  });

  it("accepts the configured ReDDone session cookie on protected routes", () => {
    const response = proxy(
      new NextRequest("https://reddone.example.test/projects", {
        headers: { cookie: "__Secure-reddone.session_token=owner-session" },
      }),
    );

    expect(response.headers.get("x-middleware-next")).toBe("1");
  });

  it("preserves the protected path and query string when redirecting to sign in", () => {
    const response = proxy(new NextRequest("https://reddone.example.test/projects/one?tab=builds&run=latest"));
    const location = new URL(response.headers.get("location")!);

    expect(location.pathname).toBe("/sign-in");
    expect(location.searchParams.get("returnTo")).toBe("/projects/one?tab=builds&run=latest");
  });

  it.each(["/", "/pricing", "/signin", "/sign-in", "/sign-up", "/forgot-password", "/reset-password"])(
    "keeps %s public outside demo mode",
    (pathname) => {
      const response = proxy(new NextRequest(`https://reddone.example.test${pathname}`));
      expect(response.headers.get("x-middleware-next")).toBe("1");
    },
  );
});
