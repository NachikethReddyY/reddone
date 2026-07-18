import { getSessionCookie } from "better-auth/cookies";
import { NextResponse, type NextRequest } from "next/server";

import { safeReturnTo } from "@/policy/return-to";

const publicPaths = [
  "/",
  "/pricing",
  "/beta",
  "/signin",
  "/sign-in",
  "/sign-up",
  "/forgot-password",
  "/reset-password",
  "/setup",
  "/preview",
  "/api/setup",
  "/api/owner",
  "/api/beta",
  "/api/waitlist",
  "/api/auth",
  "/api/health",
  "/api/webhooks",
  "/api/cron",
];

function isPublicPath(pathname: string): boolean {
  return publicPaths.some((path) => pathname === path || (path !== "/" && pathname.startsWith(`${path}/`)));
}

function configuredOrigin(value: string | undefined) {
  try {
    return value ? new URL(value).origin : null;
  } catch {
    return null;
  }
}

export function proxy(request: NextRequest) {
  const previewOrigin = configuredOrigin(process.env.PREVIEW_ORIGIN);
  const applicationOrigin = configuredOrigin(process.env.NEXT_PUBLIC_APP_URL);
  if (previewOrigin && previewOrigin !== applicationOrigin && request.nextUrl.origin === previewOrigin) {
    if (request.nextUrl.pathname === "/preview" || request.nextUrl.pathname.startsWith("/preview/")) return NextResponse.next();
    return new NextResponse("Not found", {
      status: 404,
      headers: {
        "cache-control": "private, no-store",
        "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
        "content-type": "text/plain; charset=utf-8",
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
        "x-robots-tag": "noindex, nofollow, noarchive",
      },
    });
  }
  const deploymentMode = process.env.APP_MODE ?? (process.env.NODE_ENV === "production" ? "invalid" : process.env.DEMO_MODE === "false" ? "private" : "demo");
  if (deploymentMode === "demo") return NextResponse.next();
  if (isPublicPath(request.nextUrl.pathname)) return NextResponse.next();
  if (!getSessionCookie(request, { cookiePrefix: "reddone" })) {
    const signIn = new URL("/sign-in", request.url);
    signIn.searchParams.set("returnTo", safeReturnTo(`${request.nextUrl.pathname}${request.nextUrl.search}`));
    return NextResponse.redirect(signIn);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.well-known/workflow/).*)"],
};
