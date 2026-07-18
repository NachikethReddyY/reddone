import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { BillingCheckoutInputSchema } from "@/contracts";
import {
  BILLING_PACKS,
  BILLING_PLANS,
  getBillingCatalogItem,
  publicBillingCatalog,
} from "@/server/billing-catalog";
import {
  buildStripeBillingPortalSessionParams,
  buildStripeCheckoutSessionParams,
  isNewerStripeEvent,
  projectedCheckoutStatus,
  shouldGrantPurchasedCredits,
} from "@/server/billing";
import { EnvironmentConfigurationError, getRuntimeConfig } from "@/server/env";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("approved Stripe Billing catalog", () => {
  it("uses the revised immutable SGD plan and PAYG pack quotes", () => {
    expect(BILLING_PLANS.map(({ key, amountMinor, credits }) => ({ key, amountMinor, credits }))).toEqual([
      { key: "plan_starter_sgd_v1", amountMinor: 2_000, credits: 350 },
      { key: "plan_builder_sgd_v1", amountMinor: 10_000, credits: 2_400 },
      { key: "plan_scale_sgd_v1", amountMinor: 20_000, credits: 6_000 },
    ]);
    expect(BILLING_PACKS.map(({ key, amountMinor, credits }) => ({ key, amountMinor, credits }))).toEqual([
      { key: "pack_100_sgd_v1", amountMinor: 1_000, credits: 100 },
      { key: "pack_300_sgd_v1", amountMinor: 2_500, credits: 300 },
      { key: "pack_1000_sgd_v1", amountMinor: 7_000, credits: 1_000 },
    ]);
    expect(publicBillingCatalog().plans).not.toEqual(expect.arrayContaining([expect.objectContaining({ lookupKey: expect.anything() })]));
  });

  it("accepts only server catalog keys and rejects client-controlled quote fields", () => {
    expect(BillingCheckoutInputSchema.parse({ catalogKey: "pack_100_sgd_v1" })).toEqual({
      catalogKey: "pack_100_sgd_v1",
    });
    expect(() => BillingCheckoutInputSchema.parse({ catalogKey: "pack_100_sgd_v1", amount: 1 })).toThrow();
    expect(() => BillingCheckoutInputSchema.parse({ catalogKey: "pack_100_sgd_v1", priceId: "price_attacker" })).toThrow();
    expect(() => BillingCheckoutInputSchema.parse({ catalogKey: "pack_unknown_sgd_v1" })).toThrow();
  });

  it("builds fixed Checkout parameters without restricting payment methods", () => {
    const pack = getBillingCatalogItem("pack_300_sgd_v1");
    const params = buildStripeCheckoutSessionParams({
      checkout: {
        id: "019f4f17-1fc3-7fa1-9eaa-624e8f87b2be",
        workspaceId: "019f4f17-1fc3-7fa1-9eaa-624e8f87b2bf",
        catalogKey: pack.key,
        integrationIdentifier: "reddone_checkout_abcdefgh",
      },
      item: pack,
      configuredPriceId: "price_pack300",
      customerId: null,
      customerEmail: "owner@example.test",
      appUrl: "https://console.example.test",
    });

    expect(params).toMatchObject({
      mode: "payment",
      line_items: [{ price: "price_pack300", quantity: 1 }],
      automatic_tax: { enabled: false },
      allow_promotion_codes: false,
      customer_creation: "always",
      integration_identifier: "reddone_checkout_abcdefgh",
      success_url: "https://console.example.test/payments?checkout=success",
      cancel_url: "https://console.example.test/payments?checkout=canceled",
      metadata: {
        workspaceId: "019f4f17-1fc3-7fa1-9eaa-624e8f87b2bf",
        checkoutId: "019f4f17-1fc3-7fa1-9eaa-624e8f87b2be",
        catalogKey: "pack_300_sgd_v1",
        catalogVersion: "1",
      },
      payment_intent_data: {
        metadata: expect.objectContaining({ checkoutId: "019f4f17-1fc3-7fa1-9eaa-624e8f87b2be" }),
      },
    });
    expect(params).not.toHaveProperty("payment_method_types");
    expect(params).not.toHaveProperty("subscription_data");
  });

  it("returns Stripe Checkout and Portal sessions to the dedicated payments route", () => {
    const portal = buildStripeBillingPortalSessionParams({
      customerId: "cus_existing",
      configurationId: "bpc_reddone",
      appUrl: "https://console.example.test",
    });
    expect(portal).toEqual({
      customer: "cus_existing",
      configuration: "bpc_reddone",
      return_url: "https://console.example.test/payments",
    });
  });

  it("grants PAYG credits only after a successful paid Checkout event", () => {
    expect(shouldGrantPurchasedCredits("checkout.session.completed", "paid", "pack")).toBe(true);
    expect(shouldGrantPurchasedCredits("checkout.session.async_payment_succeeded", "paid", "pack")).toBe(true);
    expect(shouldGrantPurchasedCredits("checkout.session.completed", "unpaid", "pack")).toBe(false);
    expect(shouldGrantPurchasedCredits("checkout.session.async_payment_failed", "paid", "pack")).toBe(false);
    expect(shouldGrantPurchasedCredits("checkout.session.expired", "paid", "pack")).toBe(false);
    expect(shouldGrantPurchasedCredits("checkout.session.completed", "paid", "plan")).toBe(false);
  });

  it("keeps unpaid asynchronous Checkout open and does not let stale failures overwrite paid state", () => {
    expect(projectedCheckoutStatus({
      eventType: "checkout.session.completed",
      paymentStatus: "unpaid",
      stripeStatus: "complete",
      currentStatus: "OPEN",
    })).toBe("OPEN");
    expect(projectedCheckoutStatus({
      eventType: "checkout.session.async_payment_failed",
      paymentStatus: "unpaid",
      stripeStatus: "complete",
      currentStatus: "OPEN",
    })).toBe("FAILED");
    expect(projectedCheckoutStatus({
      eventType: "checkout.session.async_payment_failed",
      paymentStatus: "paid",
      stripeStatus: "complete",
      currentStatus: "COMPLETE",
    })).toBe("COMPLETE");
    expect(projectedCheckoutStatus({
      eventType: "checkout.session.completed",
      paymentStatus: "unpaid",
      stripeStatus: "complete",
      currentStatus: "FAILED",
    })).toBe("FAILED");
  });

  it("orders equal-second Stripe events deterministically and rejects stale projections", () => {
    const lastCreatedAt = new Date(1_784_000_000_000);
    expect(isNewerStripeEvent(lastCreatedAt, "evt_b", 1_784_000_001, "evt_a")).toBe(true);
    expect(isNewerStripeEvent(lastCreatedAt, "evt_b", 1_783_999_999, "evt_z")).toBe(false);
    expect(isNewerStripeEvent(lastCreatedAt, "evt_b", 1_784_000_000, "evt_c")).toBe(true);
    expect(isNewerStripeEvent(lastCreatedAt, "evt_b", 1_784_000_000, "evt_a")).toBe(false);
  });

  it("adds server metadata to subscription Checkout without accepting a client quote", () => {
    const plan = getBillingCatalogItem("plan_starter_sgd_v1");
    const params = buildStripeCheckoutSessionParams({
      checkout: {
        id: "019f4f17-1fc3-7fa1-9eaa-624e8f87b2be",
        workspaceId: "019f4f17-1fc3-7fa1-9eaa-624e8f87b2bf",
        catalogKey: plan.key,
        integrationIdentifier: "reddone_checkout_abcdefgh",
      },
      item: plan,
      configuredPriceId: "price_starter",
      customerId: "cus_existing",
      customerEmail: "owner@example.test",
      appUrl: "https://console.example.test",
    });
    expect(params).toMatchObject({
      mode: "subscription",
      customer: "cus_existing",
      subscription_data: { metadata: expect.objectContaining({ catalogKey: "plan_starter_sgd_v1" }) },
    });
    expect(params).not.toHaveProperty("customer_creation");
    expect(params).not.toHaveProperty("payment_method_types");
  });
});

describe("Stripe environment safety", () => {
  it("rejects test/live key mismatches and browser-exposed server secrets", () => {
    expect(() => getRuntimeConfig({ STRIPE_MODE: "live", STRIPE_SECRET_KEY: "sk_test_abcdefghijklmnopqrstuvwxyz" }))
      .toThrow(EnvironmentConfigurationError);
    expect(() => getRuntimeConfig({ NEXT_PUBLIC_STRIPE_SECRET_KEY: "sk_test_abcdefghijklmnopqrstuvwxyz" }))
      .toThrow(EnvironmentConfigurationError);
  });

  it("requires all six distinct prices when Checkout is enabled", () => {
    const base = {
      BILLING_ENABLED: "true",
      BILLING_CHECKOUT_ENABLED: "true",
      DATABASE_URL: "postgresql://user:pass@localhost:5432/reddone",
      STRIPE_MODE: "test",
      STRIPE_SECRET_KEY: "rk_test_abcdefghijklmnopqrstuvwxyz",
      STRIPE_WEBHOOK_SECRET: "whsec_abcdefghijklmnopqrstuvwxyz",
    };
    expect(() => getRuntimeConfig(base)).toThrow(EnvironmentConfigurationError);
    expect(getRuntimeConfig({
      ...base,
      STRIPE_PRICE_PLAN_STARTER_SGD_V1: "price_starter",
      STRIPE_PRICE_PLAN_BUILDER_SGD_V1: "price_builder",
      STRIPE_PRICE_PLAN_SCALE_SGD_V1: "price_scale",
      STRIPE_PRICE_PACK_100_SGD_V1: "price_pack100",
      STRIPE_PRICE_PACK_300_SGD_V1: "price_pack300",
      STRIPE_PRICE_PACK_1000_SGD_V1: "price_pack1000",
    }).billing.checkoutEnabled).toBe(true);
  });
});
