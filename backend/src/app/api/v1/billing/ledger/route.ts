import { BillingLedgerQuerySchema } from "@/contracts";
import { getBillingLedgerPage } from "@/server/billing-ledger";
import { assertOwnerRequest, handleRouteError, ok, requestId } from "@/workflows/http";

export async function GET(request: Request) {
  const id = requestId(request);
  try {
    const owner = await assertOwnerRequest(request);
    const query = BillingLedgerQuerySchema.parse(Object.fromEntries(new URL(request.url).searchParams));
    return ok(await getBillingLedgerPage(owner.workspaceId, query), id);
  } catch (error) {
    return handleRouteError(error, id);
  }
}
