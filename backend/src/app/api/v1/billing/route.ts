import { getBillingSummary } from "@/server/billing";
import { AppError } from "@/server/errors";
import { apiError, assertOwnerRequest, handleRouteError, HttpError, ok, requestId } from "@/workflows/http";

export async function GET(request: Request) {
  const id = requestId(request);
  try {
    const owner = await assertOwnerRequest(request);
    return ok(await getBillingSummary(owner.workspaceId), id);
  } catch (error) {
    if (error instanceof AppError) return apiError(id, error.code, error.message, error.status, error.retryable, error.safeDetails);
    if (error instanceof HttpError) return handleRouteError(error, id);
    return apiError(id, "internal_error", "The billing summary could not be loaded.", 500, true);
  }
}
