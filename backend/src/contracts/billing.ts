import { z } from "zod";

import { CursorPageQuerySchema, IdSchema, IsoDateTimeSchema, UrlSchema } from "./common";

export const BillingCurrencySchema = z.literal("sgd");
export const BillingPlanKeySchema = z.enum([
  "plan_starter_sgd_v1",
  "plan_builder_sgd_v1",
  "plan_scale_sgd_v1",
]);
export const BillingPackKeySchema = z.enum([
  "pack_100_sgd_v1",
  "pack_300_sgd_v1",
  "pack_1000_sgd_v1",
]);
export const BillingCatalogKeySchema = z.union([BillingPlanKeySchema, BillingPackKeySchema]);
export const BillingSubscriptionStatusSchema = z.enum([
  "inactive",
  "incomplete",
  "trialing",
  "active",
  "past_due",
  "canceled",
  "unpaid",
  "paused",
]);
export const BillingCheckoutStatusSchema = z.enum(["pending", "open", "complete", "expired", "failed"]);

/** Credits are serialized as decimal strings so BigInt balances never lose precision in JSON. */
export const CreditAmountSchema = z.string().regex(/^(?:0|[1-9]\d*)$/);

const CatalogBaseSchema = z
  .object({
    key: BillingCatalogKeySchema,
    displayName: z.string().trim().min(1).max(100),
    currency: BillingCurrencySchema,
    amountMinor: z.number().int().positive(),
    credits: z.number().int().positive(),
    version: z.literal(1),
  })
  .strict();

export const BillingPlanCatalogItemSchema = CatalogBaseSchema.extend({
  key: BillingPlanKeySchema,
  kind: z.literal("plan"),
  interval: z.literal("month"),
}).strict();

export const BillingPackCatalogItemSchema = CatalogBaseSchema.extend({
  key: BillingPackKeySchema,
  kind: z.literal("pack"),
}).strict();

export const BillingCheckoutInputSchema = z
  .object({
    catalogKey: BillingCatalogKeySchema,
  })
  .strict();

export const BillingPortalInputSchema = z.object({}).strict();

export const BillingAccountSummarySchema = z
  .object({
    planKey: BillingPlanKeySchema.nullable(),
    status: BillingSubscriptionStatusSchema.nullable(),
    cancelAtPeriodEnd: z.boolean(),
    paidThroughAt: IsoDateTimeSchema.nullable(),
    hasPaidAccess: z.boolean(),
    portalAvailable: z.boolean(),
  })
  .strict();

export const BillingWalletSummarySchema = z
  .object({
    spendable: CreditAmountSchema,
    held: CreditAmountSchema,
    included: CreditAmountSchema,
    promotional: CreditAmountSchema,
    purchased: CreditAmountSchema,
    nextPurchasedExpiryAt: IsoDateTimeSchema.nullable(),
  })
  .strict();

export const BillingOperationPriceSchema = z
  .object({
    key: z.string().trim().min(1).max(100),
    label: z.string().trim().min(1).max(120),
    credits: z.number().int().nonnegative(),
    version: z.string().trim().min(1).max(100),
  })
  .strict();

export const BillingLedgerEntrySchema = z
  .object({
    id: IdSchema,
    type: z.string().trim().min(1).max(100),
    amount: z.string().regex(/^-?(?:0|[1-9]\d*)$/),
    availableDelta: z.string().regex(/^-?(?:0|[1-9]\d*)$/),
    heldDelta: z.string().regex(/^-?(?:0|[1-9]\d*)$/),
    bucket: z.string().trim().min(1).max(50).nullable(),
    description: z.string().trim().min(1).max(500),
    occurredAt: IsoDateTimeSchema,
  })
  .strict();

export const BillingLedgerQuerySchema = CursorPageQuerySchema.extend({
  limit: z.coerce.number().int().min(1).max(100).default(25),
}).strict();

export const BillingLedgerPageSchema = z
  .object({
    items: z.array(BillingLedgerEntrySchema).max(100),
    nextCursor: z.string().trim().min(1).max(1_024).nullable(),
  })
  .strict();

export const BillingSummarySchema = z
  .object({
    enabled: z.boolean(),
    checkoutEnabled: z.boolean(),
    portalEnabled: z.boolean(),
    account: BillingAccountSummarySchema,
    wallet: BillingWalletSummarySchema,
    catalog: z
      .object({
        plans: z.array(BillingPlanCatalogItemSchema),
        packs: z.array(BillingPackCatalogItemSchema),
      })
      .strict(),
    operationPrices: z.array(BillingOperationPriceSchema),
    recentLedger: z.array(BillingLedgerEntrySchema).max(100),
  })
  .strict();

export const BillingCheckoutResultSchema = z
  .object({
    checkoutId: IdSchema,
    sessionId: z.string().regex(/^cs_(?:test_|live_)?[A-Za-z0-9]+$/),
    url: UrlSchema,
    replayed: z.boolean(),
  })
  .strict();

export const BillingPortalResultSchema = z.object({ url: UrlSchema }).strict();

export type BillingPlanKey = z.infer<typeof BillingPlanKeySchema>;
export type BillingPackKey = z.infer<typeof BillingPackKeySchema>;
export type BillingCatalogKey = z.infer<typeof BillingCatalogKeySchema>;
export type BillingCheckoutInput = z.infer<typeof BillingCheckoutInputSchema>;
export type BillingLedgerEntry = z.infer<typeof BillingLedgerEntrySchema>;
export type BillingLedgerQuery = z.infer<typeof BillingLedgerQuerySchema>;
export type BillingLedgerPage = z.infer<typeof BillingLedgerPageSchema>;
export type BillingSummary = z.infer<typeof BillingSummarySchema>;
