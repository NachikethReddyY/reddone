import { ZodError } from "zod";

import { BillingCheckoutInputSchema } from "@/contracts";
import { IntegrationError } from "@/integrations/errors";
import { createBillingCheckout } from "@/server/billing";
import { AppError } from "@/server/errors";
import { apiError, handleRouteError, HttpError, mutationContext, ok, parseJson, requestId } from "@/workflows/http";

export async function POST(request: Request) {
  const id = requestId(request);
  try {
    const context = await mutationContext(request);
    const input = await parseJson(request, BillingCheckoutInputSchema);
    const result = await createBillingCheckout(
      {
        workspaceId: context.owner.workspaceId,
        userId: context.owner.userId,
        email: context.owner.email,
        idempotencyKey: context.idempotencyKey,
        requestId: context.requestId,
      },
      input.catalogKey,
    );
    return ok(result, context.requestId, { status: 201 });
  } catch (error) {
    if (error instanceof AppError) return apiError(id, error.code, error.message, error.status, error.retryable, error.safeDetails);
    if (error instanceof HttpError || error instanceof ZodError || error instanceof IntegrationError) {
      return handleRouteError(error, id);
    }
    return apiError(id, "internal_error", "Checkout could not be created.", 500, true);
  }
}
