import { ResolvedUsageQuerySchema, UsageQuerySchema } from "@/contracts";
import { isDemoMode } from "@/server/env";
import { getDemoUsageReport, getUsageReport } from "@/server/usage-reporting";
import { assertOwnerRequest, handleRouteError, ok, requestId } from "@/workflows/http";

export async function GET(request: Request) {
  const id = requestId(request);
  try {
    const owner = await assertOwnerRequest(request);
    const parsed = UsageQuerySchema.parse(Object.fromEntries(new URL(request.url).searchParams));
    const to = parsed.to ? new Date(parsed.to) : new Date();
    const from = parsed.from ? new Date(parsed.from) : new Date(to.getTime() - 30 * 24 * 60 * 60 * 1_000);
    const query = ResolvedUsageQuerySchema.parse({
      ...parsed,
      from: from.toISOString(),
      to: to.toISOString(),
    });
    const report = isDemoMode()
      ? getDemoUsageReport(query)
      : await getUsageReport(owner.workspaceId, query);
    return ok(report, id);
  } catch (error) {
    return handleRouteError(error, id);
  }
}
