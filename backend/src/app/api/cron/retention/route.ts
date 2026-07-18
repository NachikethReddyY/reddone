import { runRetentionCleanup } from "@/server/retention";
import { isDemoMode } from "@/server/env";
import { apiError, ok, requestId } from "@/workflows/http";

export async function GET(request: Request) {
  const id = requestId(request);
  if (!process.env.CRON_SECRET || request.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return apiError(id, "forbidden", "Invalid cron authorization.", 403);
  }
  if (isDemoMode()) {
    return ok({ mode: "demo", deleted: 0, externalObjectsDeleted: 0 }, id);
  }
  return ok(await runRetentionCleanup(), id);
}
