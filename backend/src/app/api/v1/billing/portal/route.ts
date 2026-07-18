import { ZodError } from "zod";

import { BillingPortalInputSchema } from "@/contracts";
import { IntegrationError } from "@/integrations/errors";
import { createBillingPortal } from "@/server/billing";
import { AppError } from "@/server/errors";
import { apiError, handleRouteError, HttpError, mutationContext, ok, parseJson, requestId } from "@/workflows/http";

export async function POST(request: Request) {
  const id = requestId(request);
  try {
    const context = await mutationContext(request);
    await parseJson(request, BillingPortalInputSchema);
    const result = await createBillingPortal({
      workspaceId: context.owner.workspaceId,
      userId: context.owner.userId,
      email: context.owner.email,
      idempotencyKey: context.idempotencyKey,
      requestId: context.requestId,
    });
    return ok(result, context.requestId, { status: 201 });
  } catch (error) {
    if (error instanceof AppError) return apiError(id, error.code, error.message, error.status, error.retryable, error.safeDetails);
    if (error instanceof HttpError || error instanceof ZodError || error instanceof IntegrationError) {
      return handleRouteError(error, id);
    }
    return apiError(id, "internal_error", "The Billing Portal could not be opened.", 500, true);
  }
}
