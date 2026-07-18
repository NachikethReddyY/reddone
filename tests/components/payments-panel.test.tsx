// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BillingPanel, getBillingPrimaryAction } from "@/features/billing/billing-panel";
import type { BillingSummary } from "@/contracts";

const baseSummary: BillingSummary = {
  enabled: true,
  checkoutEnabled: true,
  portalEnabled: true,
  account: {
    planKey: null,
    status: null,
    cancelAtPeriodEnd: false,
    paidThroughAt: null,
    hasPaidAccess: false,
    portalAvailable: false,
  },
  wallet: {
    spendable: "0",
    held: "0",
    included: "0",
    promotional: "0",
    purchased: "0",
    nextPurchasedExpiryAt: null,
  },
  catalog: {
    plans: [{
      key: "plan_starter_sgd_v1",
      kind: "plan",
      displayName: "Starter",
      currency: "sgd",
      amountMinor: 2_000,
      credits: 350,
      version: 1,
      interval: "month",
    }],
    packs: [{
      key: "pack_100_sgd_v1",
      kind: "pack",
      displayName: "100 credits",
      currency: "sgd",
      amountMinor: 1_000,
      credits: 100,
      version: 1,
    }],
  },
  operationPrices: [{ key: "research", label: "Research", credits: 20, version: "2026-07-17.v1" }],
  recentLedger: [],
};

function jsonResponse(data: unknown) {
  return new Response(JSON.stringify({ data }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("BillingPanel strict contract boundary", () => {
  it("rejects legacy compatibility aliases instead of normalizing them", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({
      billingEnabled: true,
      balances: { spendableTotal: 100 },
      plans: [],
      creditPacks: [],
    })));

    render(<BillingPanel />);

    expect(await screen.findByRole("heading", { name: "Payments are unavailable" })).toBeInTheDocument();
    expect(screen.queryByText("100 spendable")).not.toBeInTheDocument();
  });

  it("renders only canonical summary fields and keeps an empty ledger recoverable", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      return url.includes("/ledger")
        ? jsonResponse({ items: [], nextCursor: null })
        : jsonResponse(baseSummary);
    }));

    render(<BillingPanel />);

    expect(await screen.findByRole("heading", { name: "Pay as you go" })).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "No credit activity yet" })).toBeInTheDocument();
    expect(screen.getByText("Credits are not provider usage")).toBeInTheDocument();
  });
});

describe("billing action capability gating", () => {
  it("gates purchase actions on checkoutEnabled rather than enabled", () => {
    expect(getBillingPrimaryAction({ ...baseSummary, enabled: true, checkoutEnabled: false })).toMatchObject({
      kind: "checkout",
      label: "Add credits",
      disabled: true,
    });
    expect(getBillingPrimaryAction({ ...baseSummary, enabled: false, checkoutEnabled: true })).toMatchObject({
      kind: "checkout",
      label: "Add credits",
      disabled: false,
    });
  });

  it("gates payment recovery and plan management on portalEnabled", () => {
    const pastDue: BillingSummary = {
      ...baseSummary,
      enabled: false,
      portalEnabled: false,
      account: {
        ...baseSummary.account,
        planKey: "plan_starter_sgd_v1",
        status: "past_due",
        portalAvailable: true,
      },
      wallet: { ...baseSummary.wallet, spendable: "100" },
    };
    expect(getBillingPrimaryAction(pastDue)).toMatchObject({ kind: "portal", label: "Fix payment", disabled: true });
    expect(getBillingPrimaryAction({ ...pastDue, portalEnabled: true })).toMatchObject({ kind: "portal", label: "Fix payment", disabled: false });

    const healthy: BillingSummary = {
      ...pastDue,
      account: { ...pastDue.account, status: "active", hasPaidAccess: true },
    };
    expect(getBillingPrimaryAction({ ...healthy, portalEnabled: false })).toMatchObject({ kind: "portal", label: "Manage plan", disabled: true });
    expect(getBillingPrimaryAction({ ...healthy, portalEnabled: true })).toMatchObject({ kind: "portal", label: "Manage plan", disabled: false });
  });
});
