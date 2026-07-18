import { NextResponse } from "next/server";

import { getDb } from "@/server/db";
import { getRuntimeConfig } from "@/server/env";

export const dynamic = "force-dynamic";

const databaseReadinessTimeoutMs = 5_000;

async function databaseIsReady(): Promise<boolean> {
  let timeout: ReturnType<typeof setTimeout> | undefined;

  try {
    await Promise.race([
      getDb().$queryRaw`SELECT 1`,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("Database readiness check timed out")), databaseReadinessTimeoutMs);
      }),
    ]);
    return true;
  } catch {
    return false;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export async function GET() {
  const config = getRuntimeConfig();

  if (config.mode === "live" && !(await databaseIsReady())) {
    return NextResponse.json(
      { status: "unavailable", service: "reddone-control-plane", reason: "database_unavailable" },
      { status: 503 },
    );
  }

  return NextResponse.json({
    status: "ok",
    service: "reddone-control-plane",
    mode: config.mode,
    deploymentMode: config.deploymentMode,
    oxylabsConfigured: Boolean(
      process.env.OXYLABS_ENDPOINT
      && process.env.OXYLABS_PORT
      && process.env.OXYLABS_USERNAME
      && process.env.OXYLABS_PASSWORD
      && (process.env.OXYLABS_AUTHORIZATION_REFERENCE || process.env.REDDIT_APPROVAL_REFERENCE)
    ),
    timestamp: new Date().toISOString(),
  });
}
