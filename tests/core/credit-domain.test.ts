import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { ApiErrorSchema } from "@/contracts/api";
import { BILLING_PACKS, BILLING_PLANS } from "@/server/billing-catalog";
import { CREDIT_OPERATION_COSTS, CREDIT_PRICING_VERSION, quoteCreditOperation } from "@/server/credit-pricing";
import {
  allocateCreditBuckets,
  allocatePurchasedCreditLots,
  creditBalanceSummary,
  hackathonCreditCodeSuffix,
  hashHackathonCreditCode,
  purchasedCreditsExpireAt,
} from "@/server/credits";
import { InsufficientCreditsError } from "@/server/errors";
import { handleRouteError } from "@/workflows/http";

describe("customer credit domain", () => {
  it("keeps operation pricing versioned and server controlled", () => {
    expect(CREDIT_OPERATION_COSTS).toEqual({
      research: 25n,
      specification: 50n,
      build: 300n,
      polish: 240n,
      release: 40n,
      rollback: 20n,
      connection_test: 0n,
    });
    expect(quoteCreditOperation("build")).toEqual({
      operation: "build",
      pricingVersion: CREDIT_PRICING_VERSION,
      credits: 300n,
    });
  });

  it("publishes the approved SGD plans and PAYG packs", () => {
    expect(BILLING_PLANS.map(({ amountMinor, currency, credits }) => ({ amountMinor, currency, credits }))).toEqual([
      { amountMinor: 2_000, currency: "sgd", credits: 350 },
      { amountMinor: 10_000, currency: "sgd", credits: 2_400 },
      { amountMinor: 20_000, currency: "sgd", credits: 6_000 },
    ]);
    expect(BILLING_PACKS.map(({ amountMinor, currency, credits }) => ({ amountMinor, currency, credits }))).toEqual([
      { amountMinor: 1_000, currency: "sgd", credits: 100 },
      { amountMinor: 2_500, currency: "sgd", credits: 300 },
      { amountMinor: 7_000, currency: "sgd", credits: 1_000 },
    ]);
  });

  it("allocates included, promotional, then PAYG purchased credits", () => {
    expect(
      allocateCreditBuckets({ required: 80n, included: 25n, promotional: 30n, purchased: 100n }),
    ).toEqual({ included: 25n, promotional: 30n, purchased: 25n });
    expect(creditBalanceSummary({
      includedAvailable: 0n,
      includedHeld: 0n,
      promotionalAvailable: 0n,
      promotionalHeld: 0n,
      purchasedAvailable: 90n,
      purchasedHeld: 10n,
    }, false)).toEqual({ spendable: 90n, held: 10n, frozen: 0n });
  });

  it("spends purchased lots by earliest expiry and expires purchases after six months", () => {
    expect(purchasedCreditsExpireAt(new Date("2026-08-31T12:30:00.000Z")).toISOString()).toBe("2027-02-28T12:30:00.000Z");
    expect(allocatePurchasedCreditLots([
      { id: "later", availableCredits: 100n, expiresAt: new Date("2027-07-01T00:00:00.000Z") },
      { id: "first", availableCredits: 30n, expiresAt: new Date("2027-01-01T00:00:00.000Z") },
    ], 60n)).toEqual([
      { creditLotId: "first", amount: 30n, expiresAt: new Date("2027-01-01T00:00:00.000Z") },
      { creditLotId: "later", amount: 30n, expiresAt: new Date("2027-07-01T00:00:00.000Z") },
    ]);
  });

  it("hashes hackathon codes with secret material and exposes only a suffix", () => {
    const secret = "s".repeat(32);
    expect(hashHackathonCreditCode("HACK-2026-ABCDEF", secret)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashHackathonCreditCode("hack-2026-abcdef", secret)).toBe(hashHackathonCreditCode("HACK-2026-ABCDEF", secret));
    expect(hackathonCreditCodeSuffix("HACK-2026-ABCDEF")).toBe("ABCDEF");
    expect(() => hashHackathonCreditCode("HACK-2026-ABCDEF", "short")).toThrow(/32 bytes/);
  });

  it("returns typed safe insufficient-credit details", async () => {
    let error: unknown;
    try {
      allocateCreditBuckets({ required: 160n, included: 10n, promotional: 20n, purchased: 100n });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(InsufficientCreditsError);
    expect((error as InsufficientCreditsError).safeDetails).toEqual({ required: "160", spendable: "130", frozen: "0" });

    const response = handleRouteError(error, "request-1");
    expect(response.status).toBe(402);
    expect(ApiErrorSchema.parse(await response.json())).toMatchObject({
      error: {
        code: "insufficient_credits",
        retryable: false,
        details: { required: "160", spendable: "130", frozen: "0" },
      },
    });
  });
});

describe("credit persistence invariants", () => {
  const schema = readFileSync(resolve(process.cwd(), "prisma/schema.prisma"), "utf8");
  const migration = readFileSync(
    resolve(process.cwd(), "prisma/migrations/20260717000000_billing_credits/migration.sql"),
    "utf8",
  );

  it("keeps provider budget accounting separate and adds financial records", () => {
    expect(schema.match(/model BudgetReservation \{[\s\S]*?\n\}/)?.[0]).not.toContain("credit");
    expect(schema.match(/model UsageLedger \{[\s\S]*?\n\}/)?.[0]).not.toContain("credit");
    for (const model of [
      "BillingAccount",
      "BillingCheckoutSession",
      "BillingSubscriptionPeriod",
      "CreditAccount",
      "CreditReservation",
      "CreditLot",
      "CreditReservationLotAllocation",
      "CreditCode",
      "CreditCodeRedemption",
      "CreditLedger",
      "StripeEvent",
    ]) {
      expect(schema).toContain(`model ${model} {`);
    }
  });

  it("enforces nonnegative balances, consistent allocations, restricted foreign keys, and append-only history", () => {
    expect(migration).toContain('CONSTRAINT "credit_account_balances_nonnegative"');
    expect(migration).toContain('CONSTRAINT "credit_reservation_allocation_matches_quote"');
    expect(migration).toContain('CONSTRAINT "credit_reservation_terminal_timestamps"');
    expect(migration).toContain('CONSTRAINT "credit_lot_balances_and_expiry_valid"');
    expect(migration).toContain('CREATE INDEX "credit_lots_workspaceId_expiresAt_expiredAt_idx"');
    expect(migration).toContain("ON DELETE RESTRICT");
    expect(migration).toContain("BEFORE UPDATE OR DELETE ON \"credit_ledger\"");
    expect(migration).toContain("credit_ledger_append_only");
  });

  it("stores only hashed limited-use access codes with restricted redemption history", () => {
    const codeModel = schema.match(/model CreditCode \{[\s\S]*?\n\}/)?.[0] ?? "";
    expect(codeModel).toContain("codeHash");
    expect(codeModel).toContain("displaySuffix");
    expect(codeModel).not.toMatch(/plaintext|rawCode/i);
    expect(schema).toContain("HACKATHON_CODE_GRANT");
    expect(migration).toContain('CONSTRAINT "credit_code_is_valid"');
    expect(migration).toContain('credit_code_redemptions_creditCodeId_workspaceId_key');
    expect(migration).toContain('credit_ledger_workspaceId_creditCodeRedemptionId_fkey');
  });

  it("adds an explicit insufficient-credit schedule blocker", () => {
    expect(schema).toMatch(/enum ScheduleStatus \{[\s\S]*?BLOCKED[\s\S]*?\}/);
    expect(schema).toContain("blockerCode");
    expect(migration).toContain("insufficient_credits");
  });
});
