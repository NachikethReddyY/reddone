import { verifyStripeWebhook } from "@/integrations/stripe";
import { IntegrationError } from "@/integrations/errors";
import { processStripeEvent } from "@/server/billing";
import { AppError } from "@/server/errors";
import { apiError, ok, requestId } from "@/workflows/http";

export async function POST(request: Request) {
  const id = requestId(request);
  try {
    const rawBody = await request.text();
    const event = verifyStripeWebhook(rawBody, request.headers.get("stripe-signature"));
    const result = await processStripeEvent(event);
    return ok({ received: true, duplicate: result.duplicate, handled: result.handled }, id);
  } catch (error) {
    if (error instanceof AppError) return apiError(id, error.code, error.message, error.status, error.retryable, error.safeDetails);
    if (error instanceof IntegrationError) {
      return apiError(
        id,
        error.status === 400 ? "bad_request" : "provider_unavailable",
        error.message,
        error.status,
        error.retryable,
      );
    }
    return apiError(id, "internal_error", "Stripe webhook processing failed.", 500, true);
  }
}
