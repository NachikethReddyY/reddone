import "dotenv/config";

import Stripe from "stripe";

import { BILLING_CATALOG, type BillingCatalogItem } from "../src/server/billing-catalog";

const API_VERSION = "2026-06-24.dahlia" as const;
const modeArgument = process.argv.find((argument) => argument.startsWith("--mode="))?.split("=", 2)[1];
const mode = modeArgument === "live" ? "live" : modeArgument === "test" ? "test" : null;
const createMissing = process.argv.includes("--create");
const allowLive = process.argv.includes("--allow-live");

if (!mode) throw new Error("Pass --mode=test or --mode=live.");
if (mode === "live" && createMissing && !allowLive) {
  throw new Error("Live catalog creation requires both --create and --allow-live.");
}

const operatorKey = process.env.STRIPE_CATALOG_OPERATOR_KEY;
if (!operatorKey) throw new Error("STRIPE_CATALOG_OPERATOR_KEY is required.");
const expectedPrefix = new RegExp(`^(?:rk|sk)_${mode}_`);
if (!expectedPrefix.test(operatorKey)) throw new Error("The operator key mode does not match --mode.");

const stripe = new Stripe(operatorKey, {
  apiVersion: API_VERSION,
  appInfo: { name: "ReDDone Catalog Operator", version: "1" },
  maxNetworkRetries: 2,
  timeout: 20_000,
  telemetry: false,
});

function assertPrice(price: Stripe.Price, item: BillingCatalogItem) {
  const productId = typeof price.product === "string" ? price.product : price.product.id;
  if (
    !price.active ||
    price.currency !== item.currency ||
    price.unit_amount !== item.amountMinor ||
    price.type !== (item.kind === "plan" ? "recurring" : "one_time") ||
    price.lookup_key !== item.lookupKey ||
    price.metadata.catalogKey !== item.key ||
    price.metadata.catalogVersion !== String(item.version) ||
    price.metadata.credits !== String(item.credits) ||
    price.metadata.creditExpiry !== (item.kind === "plan" ? "period_end" : "six_months") ||
    (item.kind === "plan" && (price.recurring?.interval !== "month" || price.recurring.interval_count !== 1)) ||
    (item.kind === "pack" && price.recurring !== null)
  ) {
    throw new Error(`Stripe Price ${price.id} does not match immutable catalog item ${item.key}.`);
  }
  return productId;
}

function productDescription(item: BillingCatalogItem): string {
  return item.kind === "plan"
    ? `${item.credits} included credits per paid month`
    : `${item.credits} pay-as-you-go credits, valid for 6 months`;
}

function assertProduct(product: Stripe.Product | Stripe.DeletedProduct, item: BillingCatalogItem): Stripe.Product {
  if (
    product.deleted ||
    product.name !== `ReDDone ${item.displayName}` ||
    product.description !== productDescription(item) ||
    product.metadata.catalogKey !== item.key ||
    product.metadata.catalogVersion !== String(item.version) ||
    product.metadata.catalogKind !== item.kind ||
    product.metadata.credits !== String(item.credits) ||
    product.metadata.creditExpiry !== (item.kind === "plan" ? "period_end" : "six_months")
  ) {
    throw new Error(`Stripe Product ${product.id} does not match catalog item ${item.key}.`);
  }
  return product;
}

async function findProduct(item: BillingCatalogItem): Promise<Stripe.Product | null> {
  const products = await stripe.products.list({ active: true, limit: 100 }).autoPagingToArray({ limit: 1_000 });
  const matches = products.filter((product) => product.metadata.catalogKey === item.key);
  if (matches.length > 1) throw new Error(`Multiple active Stripe Products use catalog key ${item.key}.`);
  return matches[0] ?? null;
}

async function ensureProduct(item: BillingCatalogItem): Promise<Stripe.Product> {
  const existing = await findProduct(item);
  if (existing) return assertProduct(existing, item);
  if (!createMissing) throw new Error(`Missing Stripe Product for ${item.key}; rerun with --create to provision it.`);
  return stripe.products.create({
    name: `ReDDone ${item.displayName}`,
    description: productDescription(item),
    metadata: {
      catalogKey: item.key,
      catalogVersion: String(item.version),
      catalogKind: item.kind,
      credits: String(item.credits),
      creditExpiry: item.kind === "plan" ? "period_end" : "six_months",
    },
  });
}

async function ensurePrice(item: BillingCatalogItem): Promise<string> {
  const prices = await stripe.prices.list({ lookup_keys: [item.lookupKey], limit: 100 });
  if (prices.data.length > 1) throw new Error(`Multiple Stripe Prices use lookup key ${item.lookupKey}.`);
  const existing = prices.data[0];
  if (existing) {
    const productId = assertPrice(existing, item);
    assertProduct(await stripe.products.retrieve(productId), item);
    return existing.id;
  }

  const product = await ensureProduct(item);
  if (!createMissing) throw new Error(`Missing Stripe Price for ${item.key}; rerun with --create to provision it.`);
  const created = await stripe.prices.create({
    product: product.id,
    currency: item.currency,
    unit_amount: item.amountMinor,
    lookup_key: item.lookupKey,
    ...(item.kind === "plan" ? { recurring: { interval: "month" as const, interval_count: 1 } } : {}),
    metadata: {
      catalogKey: item.key,
      catalogVersion: String(item.version),
      catalogKind: item.kind,
      credits: String(item.credits),
      creditExpiry: item.kind === "plan" ? "period_end" : "six_months",
    },
  });
  assertPrice(created, item);
  return created.id;
}

const environmentNames: Record<BillingCatalogItem["key"], string> = {
  plan_starter_sgd_v1: "STRIPE_PRICE_PLAN_STARTER_SGD_V1",
  plan_builder_sgd_v1: "STRIPE_PRICE_PLAN_BUILDER_SGD_V1",
  plan_scale_sgd_v1: "STRIPE_PRICE_PLAN_SCALE_SGD_V1",
  pack_100_sgd_v1: "STRIPE_PRICE_PACK_100_SGD_V1",
  pack_300_sgd_v1: "STRIPE_PRICE_PACK_300_SGD_V1",
  pack_1000_sgd_v1: "STRIPE_PRICE_PACK_1000_SGD_V1",
};

for (const item of BILLING_CATALOG) {
  const priceId = await ensurePrice(item);
  process.stdout.write(`${environmentNames[item.key]}=${priceId}\n`);
}
