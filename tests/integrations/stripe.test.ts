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

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Stripe server integration", () => {
  it("pins the current SDK/API versions and refuses key-mode mismatches", () => {
    expect(STRIPE_SDK_VERSION).toBe("22.3.2");
    expect(STRIPE_API_VERSION).toBe("2026-06-24.dahlia");
    expect(() => createStripeClient("sk_test_abcdefghijklmnopqrstuvwxyz", "live")).toThrow(/selected mode/i);
    expect(createStripeClient("rk_test_abcdefghijklmnopqrstuvwxyz", "test")).toBeInstanceOf(Stripe);
  });

  it("verifies the raw signed payload with Stripe's signature helper", () => {
    vi.stubEnv("APP_MODE", "demo");
    vi.stubEnv("BILLING_ENABLED", "true");
    vi.stubEnv("DATABASE_URL", "postgresql://user:pass@localhost:5432/reddone");
    vi.stubEnv("STRIPE_MODE", "test");
    vi.stubEnv("STRIPE_SECRET_KEY", "rk_test_abcdefghijklmnopqrstuvwxyz");
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", "whsec_test_signing_secret_abcdefghijklmnopqrstuvwxyz");

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
      secret: "whsec_test_signing_secret_abcdefghijklmnopqrstuvwxyz",
      timestamp: Math.floor(Date.now() / 1_000),
    });

    expect(verifyStripeWebhook(payload, signature).id).toBe("evt_test_signature");
    expect(() => verifyStripeWebhook(`${payload} `, signature)).toThrow(/signature is invalid/i);
    expect(() => verifyStripeWebhook(payload, null)).toThrow(/signature is missing/i);
  });

  it("never returns raw Stripe or credential-bearing error text", () => {
    const sanitized = sanitizeStripeError(
      new Error("sk_live_do_not_expose request body card data"),
      "Checkout creation",
    );
    expect(sanitized.message).toBe("Stripe could not complete the Checkout creation request.");
    expect(sanitized.message).not.toMatch(/sk_live|card data/i);
  });
});
