import { listConnections } from "@/workflows/demo-store";
import { route } from "@/workflows/http";
import { getDb } from "@/server/db";
import { assertOwnerRequest } from "@/workflows/http";
import { isDemoMode } from "@/server/env";

export function GET(request: Request) {
  return route(request, async () => {
    if (isDemoMode()) return { items: listConnections().filter((record) => record.provider === "github" || record.provider === "vercel") };
    const owner = await assertOwnerRequest(request);
    const records = await getDb().providerConnection.findMany({
      where: { workspaceId: owner.workspaceId, provider: { in: ["GITHUB", "VERCEL"] } },
      orderBy: { provider: "asc" },
    });
    return {
      items: records.map((record) => ({
        provider: record.provider.toLowerCase(),
        mode: "live",
        health: record.health.toLowerCase(),
        accountId: record.accountExternalId,
        accountLabel: record.accountLabel,
        scopes: record.scopes,
        maskedSuffix: record.maskedSuffix,
        lastTestedAt: record.lastTestedAt?.toISOString() ?? null,
        failureCode: record.failureCode,
        failureMessage: record.failureMessage,
        optimisticVersion: record.optimisticVersion,
      })),
    };
  });
}
