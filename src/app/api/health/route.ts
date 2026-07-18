import { NextResponse } from "next/server";

import { getRuntimeConfig } from "@/server/env";

export const dynamic = "force-dynamic";

export function GET() {
  const config = getRuntimeConfig();
  return NextResponse.json({
    status: "ok",
    service: "reddone-control-plane",
    mode: config.mode,
    deploymentMode: config.deploymentMode,
    redditAuthorizationConfigured: Boolean(process.env.REDDIT_APPROVAL_REFERENCE),
    timestamp: new Date().toISOString(),
  });
}
