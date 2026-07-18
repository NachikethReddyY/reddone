import type { BillingCatalogKey, BillingPackKey, BillingPlanKey } from "@/contracts";
import type { RuntimeConfig } from "./env";

export const BILLING_CATALOG_VERSION = 1 as const;
export const BILLING_CURRENCY = "sgd" as const;

export interface BillingPlanCatalogItem {
  readonly key: BillingPlanKey;
  readonly lookupKey: string;
  readonly kind: "plan";
  readonly displayName: string;
  readonly amountMinor: number;
  readonly currency: typeof BILLING_CURRENCY;
  readonly credits: number;
  readonly interval: "month";
  readonly version: typeof BILLING_CATALOG_VERSION;
}

export interface BillingPackCatalogItem {
  readonly key: BillingPackKey;
  readonly lookupKey: string;
  readonly kind: "pack";
  readonly displayName: string;
  readonly amountMinor: number;
  readonly currency: typeof BILLING_CURRENCY;
  readonly credits: number;
  readonly version: typeof BILLING_CATALOG_VERSION;
}

export type BillingCatalogItem = BillingPlanCatalogItem | BillingPackCatalogItem;

export const BILLING_PLANS: readonly BillingPlanCatalogItem[] = Object.freeze([
  Object.freeze({
    key: "plan_starter_sgd_v1",
    lookupKey: "reddone_plan_starter_sgd_v1",
    kind: "plan",
    displayName: "Starter",
    amountMinor: 2_000,
    currency: BILLING_CURRENCY,
    credits: 350,
    interval: "month",
    version: BILLING_CATALOG_VERSION,
  }),
  Object.freeze({
    key: "plan_builder_sgd_v1",
    lookupKey: "reddone_plan_builder_sgd_v1",
    kind: "plan",
    displayName: "Builder",
    amountMinor: 10_000,
    currency: BILLING_CURRENCY,
    credits: 2_400,
    interval: "month",
    version: BILLING_CATALOG_VERSION,
  }),
  Object.freeze({
    key: "plan_scale_sgd_v1",
    lookupKey: "reddone_plan_scale_sgd_v1",
    kind: "plan",
    displayName: "Scale",
    amountMinor: 20_000,
    currency: BILLING_CURRENCY,
    credits: 6_000,
    interval: "month",
    version: BILLING_CATALOG_VERSION,
  }),
]);

export const BILLING_PACKS: readonly BillingPackCatalogItem[] = Object.freeze([
  Object.freeze({
    key: "pack_100_sgd_v1",
    lookupKey: "reddone_pack_100_sgd_v1",
    kind: "pack",
    displayName: "100 credit pack",
    amountMinor: 1_000,
    currency: BILLING_CURRENCY,
    credits: 100,
    version: BILLING_CATALOG_VERSION,
  }),
  Object.freeze({
    key: "pack_300_sgd_v1",
    lookupKey: "reddone_pack_300_sgd_v1",
    kind: "pack",
    displayName: "300 credit pack",
    amountMinor: 2_500,
    currency: BILLING_CURRENCY,
    credits: 300,
    version: BILLING_CATALOG_VERSION,
  }),
  Object.freeze({
    key: "pack_1000_sgd_v1",
    lookupKey: "reddone_pack_1000_sgd_v1",
    kind: "pack",
    displayName: "1,000 credit pack",
    amountMinor: 7_000,
    currency: BILLING_CURRENCY,
    credits: 1_000,
    version: BILLING_CATALOG_VERSION,
  }),
]);

export const BILLING_CATALOG: readonly BillingCatalogItem[] = Object.freeze([...BILLING_PLANS, ...BILLING_PACKS]);

const CATALOG_BY_KEY = new Map<BillingCatalogKey, BillingCatalogItem>(BILLING_CATALOG.map((item) => [item.key, item]));

export function getBillingCatalogItem(key: BillingCatalogKey): BillingCatalogItem {
  const item = CATALOG_BY_KEY.get(key);
  if (!item) throw new Error("Unknown server billing catalog key.");
  return item;
}

export function getConfiguredStripePriceId(
  item: BillingCatalogItem,
  priceIds: RuntimeConfig["billing"]["priceIds"],
): string | null {
  switch (item.key) {
    case "plan_starter_sgd_v1":
      return priceIds.planStarterSgdV1;
    case "plan_builder_sgd_v1":
      return priceIds.planBuilderSgdV1;
    case "plan_scale_sgd_v1":
      return priceIds.planScaleSgdV1;
    case "pack_100_sgd_v1":
      return priceIds.pack100SgdV1;
    case "pack_300_sgd_v1":
      return priceIds.pack300SgdV1;
    case "pack_1000_sgd_v1":
      return priceIds.pack1000SgdV1;
  }
}

export function publicBillingCatalog() {
  return {
    plans: BILLING_PLANS.map((item) => ({
      key: item.key,
      kind: item.kind,
      displayName: item.displayName,
      amountMinor: item.amountMinor,
      currency: item.currency,
      credits: item.credits,
      interval: item.interval,
      version: item.version,
    })),
    packs: BILLING_PACKS.map((item) => ({
      key: item.key,
      kind: item.kind,
      displayName: item.displayName,
      amountMinor: item.amountMinor,
      currency: item.currency,
      credits: item.credits,
      version: item.version,
    })),
  };
}
