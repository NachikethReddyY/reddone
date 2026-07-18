import "server-only";

import Stripe from "stripe";

import { IntegrationError } from "./errors";
import { getRuntimeConfig } from "@/server/env";

export const STRIPE_API_VERSION = "2026-06-24.dahlia" as const;
export const STRIPE_SDK_VERSION = "22.3.2" as const;

export class StripeIntegrationError extends IntegrationError {
  constructor(
    code: ConstructorParameters<typeof IntegrationError>[0],
    message: string,
    retryable = false,
    status = 502,
  ) {
    super(code, message, retryable, status);
    this.name = "StripeIntegrationError";
  }
}

function stripeKeyMode(secretKey: string): "test" | "live" | null {
  if (/^(?:rk|sk)_test_/.test(secretKey)) return "test";
  if (/^(?:rk|sk)_live_/.test(secretKey)) return "live";
  return null;
}

export function createStripeClient(secretKey: string, expectedMode: "test" | "live"): Stripe {
  if (stripeKeyMode(secretKey) !== expectedMode) {
    throw new StripeIntegrationError("not_configured", "Stripe is not configured for the selected mode.", false, 503);
  }
  return new Stripe(secretKey, {
    apiVersion: STRIPE_API_VERSION,
    appInfo: { name: "ReDDone Billing", version: "1" },
    maxNetworkRetries: 2,
    timeout: 20_000,
    telemetry: false,
  });
}

let cachedClient: Stripe | null = null;
let cachedKey: string | null = null;

export function getStripeClient(): Stripe {
  const config = getRuntimeConfig().billing;
  if (!config.secretKey) {
    throw new StripeIntegrationError("not_configured", "Stripe Billing is not configured.", false, 503);
  }
  if (!cachedClient || cachedKey !== config.secretKey) {
    cachedClient = createStripeClient(config.secretKey, config.stripeMode);
    cachedKey = config.secretKey;
  }
  return cachedClient;
}

/** Converts all SDK failures to deliberately generic messages; raw Stripe text is never returned to clients. */
export function sanitizeStripeError(error: unknown, operation: string): StripeIntegrationError {
  if (error instanceof StripeIntegrationError) return error;
  if (error instanceof Stripe.errors.StripeAuthenticationError || error instanceof Stripe.errors.StripePermissionError) {
    return new StripeIntegrationError("not_authorized", `Stripe could not authorize the ${operation} request.`, false, 503);
  }
  if (error instanceof Stripe.errors.StripeRateLimitError) {
    return new StripeIntegrationError("rate_limited", `Stripe rate-limited the ${operation} request.`, true, 429);
  }
  if (error instanceof Stripe.errors.StripeConnectionError || error instanceof Stripe.errors.StripeAPIError) {
    return new StripeIntegrationError("provider_error", `Stripe could not complete the ${operation} request.`, true, 502);
  }
  if (error instanceof Stripe.errors.StripeInvalidRequestError) {
    return new StripeIntegrationError("provider_error", `Stripe rejected the ${operation} request.`, false, 502);
  }
  return new StripeIntegrationError("provider_error", `Stripe could not complete the ${operation} request.`, false, 502);
}

export async function stripeRequest<T>(operation: string, request: () => Promise<T>): Promise<T> {
  try {
    return await request();
  } catch (error) {
    throw sanitizeStripeError(error, operation);
  }
}

export function verifyStripeWebhook(rawBody: string | Buffer, signature: string | null): Stripe.Event {
  const webhookSecret = getRuntimeConfig().billing.webhookSecret;
  if (!webhookSecret) {
    throw new StripeIntegrationError("not_configured", "Stripe webhook processing is not configured.", false, 503);
  }
  if (!signature) {
    throw new StripeIntegrationError("not_authorized", "The Stripe webhook signature is missing.", false, 400);
  }
  try {
    return getStripeClient().webhooks.constructEvent(rawBody, signature, webhookSecret);
  } catch {
    throw new StripeIntegrationError("not_authorized", "The Stripe webhook signature is invalid.", false, 400);
  }
}

export type { Stripe };
