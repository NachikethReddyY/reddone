import Stripe from "stripe";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  STRIPE_API_VERSION,
  STRIPE_SDK_VERSION,
  createStripeClient,
  sanitizeStripeError,
  verifyStripeWebhook,
} from "@/integrations/stripe";

import { stripeTestCredentials } from "../helpers/stripe-test-credentials";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Stripe server integration", () => {
  it("pins the current SDK/API versions and refuses key-mode mismatches", () => {
    expect(STRIPE_SDK_VERSION).toBe("22.3.2");
    expect(STRIPE_API_VERSION).toBe("2026-06-24.dahlia");
    expect(() => createStripeClient(stripeTestCredentials.secretKey, "live")).toThrow(/selected mode/i);
    expect(createStripeClient(stripeTestCredentials.secretKey, "test")).toBeInstanceOf(Stripe);
  });

  it("verifies the raw signed payload with Stripe's signature helper", () => {
    vi.stubEnv("APP_MODE", "demo");
    vi.stubEnv("BILLING_ENABLED", "true");
    vi.stubEnv("DATABASE_URL", "postgresql://user:pass@localhost:5432/reddone");
    vi.stubEnv("STRIPE_MODE", "test");
    vi.stubEnv("STRIPE_SECRET_KEY", stripeTestCredentials.secretKey);
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", stripeTestCredentials.webhookSecret);

    const payload = JSON.stringify({
      id: "evt_test_signature",
      object: "event",
      api_version: STRIPE_API_VERSION,
      created: 1_784_000_000,
      data: { object: { id: "cs_test_example", object: "checkout.session" } },
      livemode: false,
      pending_webhooks: 1,
      request: null,
      type: "checkout.session.completed",
    });
    const signature = Stripe.webhooks.generateTestHeaderString({
      payload,
      secret: stripeTestCredentials.webhookSecret,
      timestamp: Math.floor(Date.now() / 1_000),
    });

    expect(verifyStripeWebhook(payload, signature).id).toBe("evt_test_signature");
    expect(() => verifyStripeWebhook(`${payload} `, signature)).toThrow(/signature is invalid/i);
    expect(() => verifyStripeWebhook(payload, null)).toThrow(/signature is missing/i);
  });

  it("never returns raw Stripe or credential-bearing error text", () => {
    const sanitized = sanitizeStripeError(
      new Error(`${["sk", "live", "do_not_expose"].join("_")} request body card data`),
      "Checkout creation",
    );
    expect(sanitized.message).toBe("Stripe could not complete the Checkout creation request.");
    expect(sanitized.message).not.toContain("card data");
  });
});
