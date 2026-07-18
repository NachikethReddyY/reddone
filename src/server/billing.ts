import "server-only";

import { createHash, randomInt, randomUUID } from "node:crypto";

import { Prisma, type BillingAccount, type BillingCheckoutSession } from "@prisma/client";
import type Stripe from "stripe";

import {
  BillingCheckoutResultSchema,
  BillingPortalResultSchema,
  BillingPlanKeySchema,
  BillingSummarySchema,
  type BillingCatalogKey,
} from "@/contracts";
import {
  getStripeClient,
  stripeRequest,
} from "@/integrations/stripe";
import { IntegrationError } from "@/integrations/errors";
import { getDb, tryGetDb } from "./db";
import { CREDIT_OPERATION_COSTS, CREDIT_PRICING_VERSION } from "./credit-pricing";
import {
  ensurePromotionalGrant,
  expireStaleIncludedCredits,
  expireStalePurchasedCredits,
  grantPurchasedCredits as grantPurchasedCreditLot,
} from "./credits";
import { getRuntimeConfig } from "./env";
import { AppError } from "./errors";
import { deriveIdempotencyKey } from "./idempotency";
import {
  claimPublishedIdempotencyReceipt,
  completePublishedIdempotencyReceipt,
  completePublishedIdempotencyReceiptInTransaction,
  secureIdempotencyFingerprint,
  type PersistedIdempotencyError,
  type PublishedIdempotencyClaim,
} from "./published-idempotency";
import { canonicalJson } from "./security/canonical-json";
import { withSerializableTransaction } from "./transactions";
import {
  BILLING_PLANS,
  getBillingCatalogItem,
  getConfiguredStripePriceId,
  publicBillingCatalog,
  type BillingCatalogItem,
} from "./billing-catalog";
import { serializeBillingLedgerEntry } from "./billing-ledger";

const CHECKOUT_OPERATION = "billing.checkout.create";
const PORTAL_OPERATION = "billing.portal.create";
const CHECKOUT_IDENTIFIER_PREFIX = "reddone_checkout_";
const HANDLED_STRIPE_EVENT_TYPES = [
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
  "checkout.session.async_payment_failed",
  "checkout.session.expired",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "customer.subscription.paused",
  "customer.subscription.resumed",
  "invoice.paid",
  "invoice.payment_failed",
  "invoice.payment_action_required",
] as const;

type HandledStripeEventType = (typeof HANDLED_STRIPE_EVENT_TYPES)[number];

function isHandledStripeEventType(type: string): type is HandledStripeEventType {
  return (HANDLED_STRIPE_EVENT_TYPES as readonly string[]).includes(type);
}

type CheckoutActor = {
  workspaceId: string;
  userId: string;
  email: string;
  idempotencyKey: string;
  requestId: string;
};

export class StripeEventPayloadCollisionError extends AppError {
  constructor(eventId: string) {
    super("conflict", "A Stripe event ID was received with different payload material", {
      safeDetails: { eventId },
    });
    this.name = "StripeEventPayloadCollisionError";
  }
}

function serializable<T>(operation: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return withSerializableTransaction(getDb(), operation, { maxAttempts: 4, timeoutMs: 20_000 });
}

export function createCheckoutIntegrationIdentifier(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz";
  let suffix = "";
  for (let index = 0; index < 8; index += 1) suffix += alphabet[randomInt(alphabet.length)];
  return `${CHECKOUT_IDENTIFIER_PREFIX}${suffix}`;
}

function stripeId(value: { id: string } | string | null | undefined): string | null {
  return typeof value === "string" ? value : value?.id ?? null;
}

function dateFromUnix(value: number | null | undefined): Date | null {
  return value === null || value === undefined ? null : new Date(value * 1_000);
}

function eventPayload(event: Stripe.Event): { hash: string; json: Prisma.InputJsonValue } {
  const plain = JSON.parse(JSON.stringify(event)) as Prisma.InputJsonValue;
  const canonical = canonicalJson(plain);
  return { hash: createHash("sha256").update(canonical).digest("hex"), json: plain };
}

function stripeRequestKey(namespace: string, localId: string): string {
  return deriveIdempotencyKey(namespace, [localId]);
}

function safeBillingError(error: unknown): IntegrationError | AppError {
  if (error instanceof IntegrationError || error instanceof AppError) return error;
  return new AppError("internal_error", "The billing request could not be completed.", {
    cause: error,
    retryable: true,
  });
}

function persistedStripeError(error: unknown): PersistedIdempotencyError {
  if (error instanceof IntegrationError) {
    return {
      code: error.code === "rate_limited" ? "rate_limited" : "provider_unavailable",
      message: error.message,
      status: error.status,
      retryable: error.retryable,
    };
  }
  if (error instanceof AppError) {
    return { code: error.code, message: error.message, status: error.status, retryable: error.retryable };
  }
  return {
    code: "provider_unavailable",
    message: "Stripe could not complete the billing request.",
    status: 502,
    retryable: false,
  };
}

function replayFailure(outcome: { ok: false; error: PersistedIdempotencyError }): never {
  throw new AppError(outcome.error.code as ConstructorParameters<typeof AppError>[0], outcome.error.message, {
    retryable: outcome.error.retryable,
  });
}

function requireBillingEnabled(capability: "summary" | "checkout" | "portal") {
  const billing = getRuntimeConfig().billing;
  const enabled = capability === "summary"
    ? billing.enabled
    : capability === "checkout"
      ? billing.checkoutEnabled
      : billing.portalEnabled;
  if (!enabled) throw new AppError("feature_disabled", `Billing ${capability} is not enabled.`);
  return billing;
}

function priceIdFor(item: BillingCatalogItem): string {
  const id = getConfiguredStripePriceId(item, requireBillingEnabled("checkout").priceIds);
  if (!id) throw new AppError("feature_disabled", "The selected billing catalog item is not configured.");
  return id;
}

function isNonterminalSubscription(account: BillingAccount | null): boolean {
  return Boolean(account && !["INACTIVE", "CANCELED"].includes(account.status));
}

function accountHasPaidAccess(account: BillingAccount | null, now = new Date()): boolean {
  return Boolean(account?.paidThroughAt && account.paidThroughAt.getTime() > now.getTime());
}

function tierForPlan(key: string): "STARTER" | "BUILDER" | "SCALE" {
  switch (BillingPlanKeySchema.parse(key)) {
    case "plan_starter_sgd_v1":
      return "STARTER";
    case "plan_builder_sgd_v1":
      return "BUILDER";
    case "plan_scale_sgd_v1":
      return "SCALE";
  }
}

function subscriptionStatus(status: Stripe.Subscription.Status) {
  switch (status) {
    case "active":
      return "ACTIVE" as const;
    case "trialing":
      return "TRIALING" as const;
    case "past_due":
      return "PAST_DUE" as const;
    case "paused":
      return "PAUSED" as const;
    case "canceled":
      return "CANCELED" as const;
    case "unpaid":
      return "UNPAID" as const;
    case "incomplete":
      return "INCOMPLETE" as const;
    case "incomplete_expired":
      return "INACTIVE" as const;
  }
}

export function isNewerStripeEvent(
  lastCreatedAt: Date | null,
  lastEventId: string | null,
  eventCreated: number,
  eventId: string,
): boolean {
  if (!lastCreatedAt) return true;
  const created = eventCreated * 1_000;
  const previous = lastCreatedAt.getTime();
  return created > previous || (created === previous && eventId > (lastEventId ?? ""));
}

function newerProjection(account: BillingAccount, event: Stripe.Event): boolean {
  return isNewerStripeEvent(account.lastStripeEventCreatedAt, account.lastStripeEventId, event.created, event.id);
}

function publicOperationPrices() {
  const labels: Record<keyof typeof CREDIT_OPERATION_COSTS, string> = {
    research: "Research",
    specification: "Specification",
    build: "Build",
    polish: "Polish",
    release: "Release",
    rollback: "Rollback",
    connection_test: "Connection test",
  };
  return Object.entries(CREDIT_OPERATION_COSTS).map(([key, credits]) => ({
    key,
    label: labels[key as keyof typeof CREDIT_OPERATION_COSTS],
    credits: Number(credits),
    version: CREDIT_PRICING_VERSION,
  }));
}

export async function getBillingSummary(workspaceId: string) {
  const config = getRuntimeConfig().billing;
  const persistedWorkspace = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(workspaceId);
  const db = persistedWorkspace ? tryGetDb() : null;
  if (!db) {
    return BillingSummarySchema.parse({
      enabled: config.enabled,
      checkoutEnabled: false,
      portalEnabled: false,
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
      catalog: publicBillingCatalog(),
      operationPrices: publicOperationPrices(),
      recentLedger: [],
    });
  }

  await serializable(async (tx) => {
    const now = new Date();
    await ensurePromotionalGrant(tx, { workspaceId, now });
    await expireStaleIncludedCredits(tx, { workspaceId, now });
    await expireStalePurchasedCredits(tx, { workspaceId, now });
  });

  const [account, credit, ledger, nextPurchasedLot] = await Promise.all([
    db.billingAccount.findUnique({ where: { workspaceId } }),
    db.creditAccount.findUnique({ where: { workspaceId } }),
    db.creditLedger.findMany({
      where: { workspaceId },
      orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
      take: 50,
    }),
    db.creditLot.findFirst({
      where: { workspaceId, expiredAt: null, availableCredits: { gt: 0n } },
      orderBy: [{ expiresAt: "asc" }, { id: "asc" }],
      select: { expiresAt: true },
    }),
  ]);
  const included = credit?.includedAvailable ?? 0n;
  const promotional = credit?.promotionalAvailable ?? 0n;
  const purchased = credit?.purchasedAvailable ?? 0n;
  const held = (credit?.includedHeld ?? 0n) + (credit?.promotionalHeld ?? 0n) + (credit?.purchasedHeld ?? 0n);
  const planKey = account?.catalogKey && BillingPlanKeySchema.safeParse(account.catalogKey).success
    ? BillingPlanKeySchema.parse(account.catalogKey)
    : null;

  return BillingSummarySchema.parse({
    enabled: config.enabled,
    checkoutEnabled: config.checkoutEnabled,
    portalEnabled: config.portalEnabled,
    account: {
      planKey,
      status: account?.status.toLowerCase() ?? null,
      cancelAtPeriodEnd: account?.cancelAtPeriodEnd ?? false,
      paidThroughAt: account?.paidThroughAt?.toISOString() ?? null,
      hasPaidAccess: accountHasPaidAccess(account),
      portalAvailable: Boolean(config.portalEnabled && account?.stripeCustomerId),
    },
    wallet: {
      spendable: String(included + promotional + purchased),
      held: String(held),
      included: String(included),
      promotional: String(promotional),
      purchased: String(purchased),
      nextPurchasedExpiryAt: nextPurchasedLot?.expiresAt.toISOString() ?? null,
    },
    catalog: publicBillingCatalog(),
    operationPrices: publicOperationPrices(),
    recentLedger: ledger.map(serializeBillingLedgerEntry),
  });
}

async function createLocalCheckout(actor: CheckoutActor, item: BillingCatalogItem, configuredPriceId: string) {
  return serializable(async (tx) => {
    const now = new Date();
    await tx.billingCheckoutSession.updateMany({
      where: {
        workspaceId: actor.workspaceId,
        OR: [
          { status: "OPEN", expiresAt: { lte: now } },
          { status: "PENDING", createdAt: { lte: new Date(now.getTime() - 25 * 60 * 60_000) } },
        ],
      },
      data: { status: "EXPIRED", failedAt: now },
    });
    const account = await tx.billingAccount.findUnique({ where: { workspaceId: actor.workspaceId } });
    if (item.kind === "plan" && isNonterminalSubscription(account)) {
      throw new AppError("conflict", "An existing subscription must be managed in the Billing Portal.");
    }
    const existing = await tx.billingCheckoutSession.findUnique({
      where: { workspaceId_requestIdempotencyKey: { workspaceId: actor.workspaceId, requestIdempotencyKey: actor.idempotencyKey } },
    });
    if (existing) {
      if (
        existing.catalogKey !== item.key ||
        existing.quotedAmountMinor !== BigInt(item.amountMinor) ||
        existing.quotedCredits !== BigInt(item.credits)
      ) {
        throw new AppError("conflict", "The idempotency key was already used for a different billing item.");
      }
      return { checkout: existing, account };
    }
    if (item.kind === "plan") {
      const pendingSubscription = await tx.billingCheckoutSession.findFirst({
        where: { workspaceId: actor.workspaceId, kind: "SUBSCRIPTION", status: { in: ["PENDING", "OPEN"] } },
        select: { id: true },
      });
      if (pendingSubscription) throw new AppError("conflict", "A subscription Checkout is already pending.");
    }
    if (!account?.stripeCustomerId) {
      const initializingCustomer = await tx.billingCheckoutSession.findFirst({
        where: { workspaceId: actor.workspaceId, status: { in: ["PENDING", "OPEN"] } },
        select: { id: true },
      });
      if (initializingCustomer) {
        throw new AppError("conflict", "Complete or expire the current Checkout before starting another one.");
      }
    }
    const billingAccount = account ?? await tx.billingAccount.create({ data: { workspaceId: actor.workspaceId } });
    const checkout = await tx.billingCheckoutSession.create({
      data: {
        id: randomUUID(),
        workspaceId: actor.workspaceId,
        billingAccountId: billingAccount.id,
        kind: item.kind === "plan" ? "SUBSCRIPTION" : "CREDIT_PACK",
        catalogKey: item.key,
        currency: item.currency,
        quotedAmountMinor: BigInt(item.amountMinor),
        quotedCredits: BigInt(item.credits),
        integrationIdentifier: createCheckoutIntegrationIdentifier(),
        requestIdempotencyKey: actor.idempotencyKey,
      },
    });
    return { checkout, account: billingAccount, configuredPriceId };
  });
}

function checkoutMetadata(
  checkout: Pick<BillingCheckoutSession, "id" | "workspaceId" | "catalogKey">,
) {
  return {
    workspaceId: checkout.workspaceId,
    checkoutId: checkout.id,
    catalogKey: checkout.catalogKey,
    catalogVersion: "1",
  };
}

export function buildStripeCheckoutSessionParams(input: {
  checkout: Pick<BillingCheckoutSession, "id" | "workspaceId" | "catalogKey" | "integrationIdentifier">;
  item: BillingCatalogItem;
  configuredPriceId: string;
  customerId: string | null;
  customerEmail: string;
  appUrl: string;
}): Stripe.Checkout.SessionCreateParams {
  const metadata = checkoutMetadata(input.checkout);
  const commonParams = {
    line_items: [{ price: input.configuredPriceId, quantity: 1 }],
    integration_identifier: input.checkout.integrationIdentifier,
    client_reference_id: input.checkout.id,
    success_url: `${input.appUrl}/payments?checkout=success`,
    cancel_url: `${input.appUrl}/payments?checkout=canceled`,
    automatic_tax: { enabled: false as const },
    allow_promotion_codes: false,
    metadata,
    ...(input.customerId ? { customer: input.customerId } : { customer_email: input.customerEmail }),
  };
  return input.item.kind === "plan"
    ? { ...commonParams, mode: "subscription", subscription_data: { metadata } }
    : {
        ...commonParams,
        mode: "payment",
        ...(!input.customerId ? { customer_creation: "always" as const } : {}),
        payment_intent_data: { metadata },
      };
}

export function buildStripeBillingPortalSessionParams(input: {
  customerId: string;
  configurationId: string;
  appUrl: string;
}): Stripe.BillingPortal.SessionCreateParams {
  return {
    customer: input.customerId,
    configuration: input.configurationId,
    return_url: `${input.appUrl}/payments`,
  };
}

export async function createBillingCheckout(actor: CheckoutActor, catalogKey: BillingCatalogKey) {
  requireBillingEnabled("checkout");
  const item = getBillingCatalogItem(catalogKey);
  const configuredPriceId = priceIdFor(item);
  const fingerprint = secureIdempotencyFingerprint(CHECKOUT_OPERATION, { catalogKey: item.key });
  const receipt = await claimPublishedIdempotencyReceipt({
    workspaceId: actor.workspaceId,
    idempotencyKey: actor.idempotencyKey,
    operation: CHECKOUT_OPERATION,
    requestFingerprint: fingerprint,
  });
  if (receipt.kind === "in_progress") throw new AppError("conflict", "This Checkout request is already in progress.");
  if (receipt.kind === "replay") {
    if (!receipt.outcome.ok) replayFailure(receipt.outcome);
    const replayed = BillingCheckoutResultSchema.parse(receipt.outcome.response);
    return { ...replayed, replayed: true };
  }

  const claim: PublishedIdempotencyClaim = receipt.claim;
  let externalSucceeded = false;
  try {
    const { checkout, account } = await createLocalCheckout(actor, item, configuredPriceId);
    if (checkout.stripeCheckoutSessionId) {
      const existing = await stripeRequest("Checkout retrieval", () =>
        getStripeClient().checkout.sessions.retrieve(checkout.stripeCheckoutSessionId!),
      );
      if (!existing.url) throw new AppError("conflict", "The existing Stripe Checkout Session has no hosted URL.");
      externalSucceeded = true;
      const result = BillingCheckoutResultSchema.parse({
        checkoutId: checkout.id,
        sessionId: existing.id,
        url: existing.url,
        replayed: true,
      });
      await completePublishedIdempotencyReceipt({
        workspaceId: actor.workspaceId,
        claim,
        operation: CHECKOUT_OPERATION,
        requestFingerprint: fingerprint,
        outcome: { ok: true, response: result },
      });
      return result;
    }

    const params = buildStripeCheckoutSessionParams({
      checkout,
      item,
      configuredPriceId,
      customerId: account?.stripeCustomerId ?? null,
      customerEmail: actor.email,
      appUrl: getRuntimeConfig().appUrl,
    });
    const session = await stripeRequest("Checkout creation", () =>
      getStripeClient().checkout.sessions.create(params, {
        idempotencyKey: stripeRequestKey("billing-checkout", checkout.id),
      }),
    );
    if (!session.url) throw new AppError("internal_error", "Stripe did not return a hosted Checkout URL.");
    externalSucceeded = true;

    const result = BillingCheckoutResultSchema.parse({
      checkoutId: checkout.id,
      sessionId: session.id,
      url: session.url,
      replayed: false,
    });
    await serializable(async (tx) => {
      await tx.billingCheckoutSession.update({
        where: { id: checkout.id },
        data: {
          status: "OPEN",
          stripeCheckoutSessionId: session.id,
          stripeCustomerId: stripeId(session.customer),
          stripePaymentIntentId: stripeId(session.payment_intent),
          stripeSubscriptionId: stripeId(session.subscription),
          expiresAt: dateFromUnix(session.expires_at),
        },
      });
      await completePublishedIdempotencyReceiptInTransaction(tx, {
        workspaceId: actor.workspaceId,
        claim,
        operation: CHECKOUT_OPERATION,
        requestFingerprint: fingerprint,
        outcome: { ok: true, response: result },
        audit: {
          actorUserId: actor.userId,
          action: "billing.checkout.created",
          targetType: "billing_checkout_session",
          targetId: checkout.id,
          requestId: actor.requestId,
          metadata: { catalogKey: item.key, kind: item.kind },
        },
      });
    });
    return result;
  } catch (error) {
    const safe = safeBillingError(error);
    if (!externalSucceeded) {
      await completePublishedIdempotencyReceipt({
        workspaceId: actor.workspaceId,
        claim,
        operation: CHECKOUT_OPERATION,
        requestFingerprint: fingerprint,
        outcome: { ok: false, error: persistedStripeError(safe) },
      }).catch(() => undefined);
    }
    throw safe;
  }
}

export async function createBillingPortal(actor: CheckoutActor) {
  const billing = requireBillingEnabled("portal");
  const account = await getDb().billingAccount.findUnique({ where: { workspaceId: actor.workspaceId } });
  if (!account?.stripeCustomerId) throw new AppError("not_found", "No Stripe customer exists for this workspace.");
  if (!billing.portalConfigurationId) throw new AppError("feature_disabled", "The Billing Portal is not configured.");

  const fingerprint = secureIdempotencyFingerprint(PORTAL_OPERATION, { customerId: account.stripeCustomerId });
  const receipt = await claimPublishedIdempotencyReceipt({
    workspaceId: actor.workspaceId,
    idempotencyKey: actor.idempotencyKey,
    operation: PORTAL_OPERATION,
    requestFingerprint: fingerprint,
  });
  if (receipt.kind === "in_progress") throw new AppError("conflict", "This Billing Portal request is already in progress.");
  if (receipt.kind === "replay") {
    if (!receipt.outcome.ok) replayFailure(receipt.outcome);
    return BillingPortalResultSchema.parse(receipt.outcome.response);
  }

  let externalSucceeded = false;
  try {
    const session = await stripeRequest("Billing Portal creation", () =>
      getStripeClient().billingPortal.sessions.create(
        buildStripeBillingPortalSessionParams({
          customerId: account.stripeCustomerId!,
          configurationId: billing.portalConfigurationId!,
          appUrl: getRuntimeConfig().appUrl,
        }),
        { idempotencyKey: stripeRequestKey("billing-portal", receipt.claim.receiptId) },
      ),
    );
    externalSucceeded = true;
    const result = BillingPortalResultSchema.parse({ url: session.url });
    await completePublishedIdempotencyReceipt({
      workspaceId: actor.workspaceId,
      claim: receipt.claim,
      operation: PORTAL_OPERATION,
      requestFingerprint: fingerprint,
      outcome: { ok: true, response: result },
      audit: {
        actorUserId: actor.userId,
        action: "billing.portal.created",
        targetType: "billing_account",
        targetId: account.id,
        requestId: actor.requestId,
        metadata: {},
      },
    });
    return result;
  } catch (error) {
    const safe = safeBillingError(error);
    if (!externalSucceeded) {
      await completePublishedIdempotencyReceipt({
        workspaceId: actor.workspaceId,
        claim: receipt.claim,
        operation: PORTAL_OPERATION,
        requestFingerprint: fingerprint,
        outcome: { ok: false, error: persistedStripeError(safe) },
      }).catch(() => undefined);
    }
    throw safe;
  }
}

async function hydratedEvent(event: Stripe.Event): Promise<Stripe.Event> {
  if (!isHandledStripeEventType(event.type) || !event.type.startsWith("checkout.session.")) return event;
  const session = event.data.object as Stripe.Checkout.Session;
  const expand = ["line_items"];
  if (
    session.metadata?.catalogKey?.startsWith("pack_")
    && (event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded")
  ) {
    expand.push("payment_intent");
  }
  const hydrated = await stripeRequest("Checkout reconciliation", () =>
    getStripeClient().checkout.sessions.retrieve(session.id, { expand }),
  );
  const copy = JSON.parse(JSON.stringify(event)) as Stripe.Event;
  (copy.data as { object: Stripe.Checkout.Session }).object = hydrated;
  return copy;
}

function assertEventMode(event: Stripe.Event) {
  const expectedLive = getRuntimeConfig().billing.stripeMode === "live";
  if (event.livemode !== expectedLive) throw new AppError("conflict", "Stripe event mode does not match server configuration.");
}

function assertMetadata(
  metadata: Stripe.Metadata | null | undefined,
  checkout: BillingCheckoutSession,
) {
  if (
    metadata?.workspaceId !== checkout.workspaceId ||
    metadata.checkoutId !== checkout.id ||
    metadata.catalogKey !== checkout.catalogKey ||
    metadata.catalogVersion !== "1"
  ) {
    throw new AppError("conflict", "Stripe metadata does not match the persisted Checkout intent.");
  }
}

function sessionLinePriceId(session: Stripe.Checkout.Session): string | null {
  const lines = session.line_items?.data ?? [];
  if (lines.length !== 1 || lines[0]?.quantity !== 1) return null;
  return stripeId(lines[0].price);
}

async function resolveCheckout(tx: Prisma.TransactionClient, session: Stripe.Checkout.Session) {
  const metadataId = session.metadata?.checkoutId;
  const checkout = await tx.billingCheckoutSession.findFirst({
    where: {
      OR: [
        { stripeCheckoutSessionId: session.id },
        ...(metadataId ? [{ id: metadataId }] : []),
        ...(session.client_reference_id ? [{ id: session.client_reference_id }] : []),
      ],
    },
  });
  if (!checkout) throw new AppError("not_found", "Stripe Checkout intent was not found.");
  assertMetadata(session.metadata, checkout);
  if (session.integration_identifier !== checkout.integrationIdentifier) {
    throw new AppError("conflict", "Stripe integration identifier does not match the persisted Checkout intent.");
  }
  const item = getBillingCatalogItem(checkout.catalogKey as BillingCatalogKey);
  const expectedPrice = getConfiguredStripePriceId(item, getRuntimeConfig().billing.priceIds);
  if (
    !expectedPrice ||
    sessionLinePriceId(session) !== expectedPrice ||
    session.currency !== checkout.currency ||
    session.amount_total !== Number(checkout.quotedAmountMinor) ||
    item.credits !== Number(checkout.quotedCredits) ||
    item.amountMinor !== Number(checkout.quotedAmountMinor)
  ) {
    throw new AppError("conflict", "Stripe Checkout values do not match the server-owned quote.");
  }
  if (checkout.stripeCustomerId && stripeId(session.customer) !== checkout.stripeCustomerId) {
    throw new AppError("conflict", "Stripe Checkout used a different customer than the persisted intent.");
  }
  return { checkout, item };
}

async function unblockCreditSchedules(tx: Prisma.TransactionClient, workspaceId: string) {
  await tx.schedule.updateMany({
    where: { workspaceId, status: "BLOCKED", blockerCode: "insufficient_credits" },
    data: { status: "ENABLED", blockerCode: null, blockerMessage: null, blockedAt: null, backoffUntil: null },
  });
}

async function lockCreditAccount(tx: Prisma.TransactionClient, workspaceId: string) {
  await tx.$queryRaw(Prisma.sql`
    SELECT "id" FROM "credit_accounts" WHERE "workspaceId" = ${workspaceId}::uuid FOR UPDATE
  `);
  return tx.creditAccount.findUniqueOrThrow({ where: { workspaceId } });
}

async function grantPurchasedCredits(
  tx: Prisma.TransactionClient,
  event: Stripe.Event,
  checkout: BillingCheckoutSession,
  item: BillingCatalogItem,
  paidAt: Date,
) {
  if (item.kind !== "pack") throw new AppError("conflict", "A subscription item cannot be granted as purchased credits.");
  await ensurePromotionalGrant(tx, { workspaceId: checkout.workspaceId, now: paidAt });
  const grant = await grantPurchasedCreditLot(tx, {
    workspaceId: checkout.workspaceId,
    credits: BigInt(item.credits),
    externalReference: `stripe-checkout:${checkout.id}`,
    checkoutSessionId: checkout.id,
    stripeEventId: event.id,
    purchasedAt: paidAt,
  });
  if (grant.granted) await unblockCreditSchedules(tx, checkout.workspaceId);
}

export function shouldGrantPurchasedCredits(
  eventType: string,
  paymentStatus: Stripe.Checkout.Session.PaymentStatus,
  itemKind: BillingCatalogItem["kind"],
): boolean {
  return itemKind === "pack"
    && paymentStatus === "paid"
    && (eventType === "checkout.session.completed" || eventType === "checkout.session.async_payment_succeeded");
}

export function projectedCheckoutStatus(input: {
  eventType: string;
  paymentStatus: Stripe.Checkout.Session.PaymentStatus;
  stripeStatus: Stripe.Checkout.Session.Status | null;
  currentStatus: BillingCheckoutSession["status"];
}): BillingCheckoutSession["status"] {
  if (input.stripeStatus === "expired" || input.eventType === "checkout.session.expired") return "EXPIRED";
  if (input.paymentStatus === "paid") return "COMPLETE";
  if (input.eventType === "checkout.session.async_payment_failed") return "FAILED";
  if (input.currentStatus === "FAILED") return "FAILED";
  return "OPEN";
}

async function applyCheckoutEvent(tx: Prisma.TransactionClient, event: Stripe.Event) {
  const session = event.data.object as Stripe.Checkout.Session;
  const { checkout, item } = await resolveCheckout(tx, session);
  const customerId = stripeId(session.customer);
  const paymentIntentId = stripeId(session.payment_intent);
  const subscriptionId = stripeId(session.subscription);

  if (shouldGrantPurchasedCredits(event.type, session.payment_status, item.kind)) {
    const paymentIntent = typeof session.payment_intent === "object" ? session.payment_intent : null;
    assertMetadata(paymentIntent?.metadata, checkout);
    await grantPurchasedCredits(tx, event, checkout, item, dateFromUnix(event.created) ?? new Date());
  }

  const status = projectedCheckoutStatus({
    eventType: event.type,
    paymentStatus: session.payment_status,
    stripeStatus: session.status,
    currentStatus: checkout.status,
  });
  await tx.billingCheckoutSession.update({
    where: { id: checkout.id },
    data: {
      status,
      stripeCheckoutSessionId: session.id,
      stripeCustomerId: customerId,
      stripePaymentIntentId: paymentIntentId,
      stripeSubscriptionId: subscriptionId,
      completedAt: status === "COMPLETE" ? new Date() : null,
      failedAt: status === "FAILED" ? new Date() : null,
      expiresAt: dateFromUnix(session.expires_at),
    },
  });
  if (customerId) {
    const localAccount = await tx.billingAccount.findUniqueOrThrow({ where: { workspaceId: checkout.workspaceId } });
    const startsSubscription = item.kind === "plan"
      && subscriptionId !== null
      && localAccount.stripeSubscriptionId !== subscriptionId
      && ["INACTIVE", "CANCELED"].includes(localAccount.status);
    await tx.billingAccount.update({
      where: { workspaceId: checkout.workspaceId },
      data: {
        stripeCustomerId: customerId,
        ...(item.kind === "plan" && subscriptionId ? { stripeSubscriptionId: subscriptionId } : {}),
        ...(startsSubscription ? { status: "INCOMPLETE" as const } : {}),
      },
    });
  }
  return checkout.workspaceId;
}

function subscriptionPlan(subscription: Stripe.Subscription) {
  if (subscription.items.data.length !== 1) throw new AppError("conflict", "Stripe subscription has an unsupported item count.");
  const subscriptionItem = subscription.items.data[0]!;
  const priceId = stripeId(subscriptionItem.price);
  const plan = BILLING_PLANS.find((candidate) =>
    getConfiguredStripePriceId(candidate, getRuntimeConfig().billing.priceIds) === priceId,
  );
  if (!plan || subscriptionItem.quantity !== 1) {
    throw new AppError("conflict", "Stripe subscription does not match the configured plan catalog.");
  }
  return { plan, subscriptionItem };
}

async function resolveSubscriptionWorkspace(tx: Prisma.TransactionClient, subscription: Stripe.Subscription) {
  const customerId = stripeId(subscription.customer);
  const byId = await tx.billingAccount.findFirst({
    where: { OR: [{ stripeSubscriptionId: subscription.id }, ...(customerId ? [{ stripeCustomerId: customerId }] : [])] },
  });
  const metadataWorkspaceId = subscription.metadata.workspaceId;
  const checkoutId = subscription.metadata.checkoutId;
  const checkout = checkoutId ? await tx.billingCheckoutSession.findUnique({ where: { id: checkoutId } }) : null;
  const workspaceId = byId?.workspaceId ?? checkout?.workspaceId ?? metadataWorkspaceId;
  if (!workspaceId) throw new AppError("not_found", "Stripe subscription workspace could not be resolved.");
  if (
    (metadataWorkspaceId && metadataWorkspaceId !== workspaceId) ||
    (checkout && checkout.workspaceId !== workspaceId) ||
    (byId && byId.workspaceId !== workspaceId)
  ) {
    throw new AppError("conflict", "Stripe subscription correlation data disagrees with local ownership.");
  }
  return { workspaceId, existing: byId };
}

async function applySubscriptionEvent(tx: Prisma.TransactionClient, event: Stripe.Event) {
  const subscription = event.data.object as Stripe.Subscription;
  const { plan, subscriptionItem } = subscriptionPlan(subscription);
  const resolved = await resolveSubscriptionWorkspace(tx, subscription);
  if (subscription.metadata.catalogKey && subscription.metadata.catalogKey !== plan.key) {
    throw new AppError("conflict", "Stripe subscription metadata does not match its configured Price.");
  }
  const customerId = stripeId(subscription.customer);
  const account = resolved.existing ?? await tx.billingAccount.create({ data: { workspaceId: resolved.workspaceId } });
  if (!newerProjection(account, event)) return resolved.workspaceId;
  await tx.billingAccount.update({
    where: { id: account.id },
    data: {
      stripeCustomerId: customerId,
      stripeSubscriptionId: subscription.id,
      tier: tierForPlan(plan.key),
      catalogKey: plan.key,
      stripePriceId: stripeId(subscriptionItem.price),
      status: subscriptionStatus(subscription.status),
      cancelAtPeriodEnd: subscription.cancel_at_period_end,
      currentPeriodStart: dateFromUnix(subscriptionItem.current_period_start),
      currentPeriodEnd: dateFromUnix(subscriptionItem.current_period_end),
      lastStripeEventCreatedAt: dateFromUnix(event.created),
      lastStripeEventId: event.id,
    },
  });
  return resolved.workspaceId;
}

function invoiceSubscriptionId(invoice: Stripe.Invoice): string | null {
  return stripeId(invoice.parent?.subscription_details?.subscription ?? null);
}

async function resolveInvoiceAccount(tx: Prisma.TransactionClient, invoice: Stripe.Invoice) {
  const subscriptionId = invoiceSubscriptionId(invoice);
  if (!subscriptionId) throw new AppError("conflict", "Stripe invoice is not linked to a subscription.");
  const metadata = invoice.parent?.subscription_details?.metadata;
  const checkout = metadata?.checkoutId
    ? await tx.billingCheckoutSession.findUnique({ where: { id: metadata.checkoutId } })
    : null;
  let account = await tx.billingAccount.findUnique({ where: { stripeSubscriptionId: subscriptionId } });
  const workspaceId = account?.workspaceId ?? checkout?.workspaceId ?? metadata?.workspaceId;
  if (!workspaceId) throw new AppError("not_found", "Stripe invoice workspace could not be resolved.");
  if (
    (metadata?.workspaceId && metadata.workspaceId !== workspaceId) ||
    (checkout && checkout.workspaceId !== workspaceId)
  ) {
    throw new AppError("conflict", "Stripe invoice correlation data disagrees with local ownership.");
  }
  account ??= await tx.billingAccount.findUnique({ where: { workspaceId } });
  if (!account) throw new AppError("not_found", "Stripe invoice billing account was not found locally.");
  const customerId = stripeId(invoice.customer);
  if (account.stripeCustomerId && customerId !== account.stripeCustomerId) {
    throw new AppError("conflict", "Stripe invoice customer disagrees with the local billing account.");
  }
  if (!account.stripeCustomerId || !account.stripeSubscriptionId) {
    account = await tx.billingAccount.update({
      where: { id: account.id },
      data: {
        ...(customerId ? { stripeCustomerId: customerId } : {}),
        ...(!account.stripeSubscriptionId ? { stripeSubscriptionId: subscriptionId } : {}),
      },
    });
  }
  return { account, subscriptionId, metadata };
}

function paidInvoicePlan(invoice: Stripe.Invoice, metadata: Stripe.Metadata | null | undefined) {
  const lines = invoice.lines.data.filter((line) =>
    line.parent?.type === "subscription_item_details" && !line.parent.subscription_item_details?.proration,
  );
  if (lines.length !== 1) throw new AppError("conflict", "Stripe invoice has an unsupported subscription line count.");
  const line = lines[0]!;
  const linePriceId = stripeId(line.pricing?.price_details?.price);
  const plan = BILLING_PLANS.find((candidate) =>
    getConfiguredStripePriceId(candidate, getRuntimeConfig().billing.priceIds) === linePriceId,
  );
  if (
    !plan ||
    (metadata?.catalogKey && metadata.catalogKey !== plan.key) ||
    line.quantity !== 1 ||
    line.currency !== plan.currency ||
    line.amount !== plan.amountMinor ||
    invoice.currency !== plan.currency ||
    invoice.total !== plan.amountMinor ||
    invoice.status !== "paid"
  ) {
    throw new AppError("conflict", "Stripe invoice does not match the server-owned subscription quote.");
  }
  return { plan, line };
}

async function grantIncludedCredits(
  tx: Prisma.TransactionClient,
  event: Stripe.Event,
  invoice: Stripe.Invoice,
  account: BillingAccount,
  subscriptionId: string,
  metadata: Stripe.Metadata | null | undefined,
) {
  const existing = await tx.billingSubscriptionPeriod.findUnique({ where: { stripeInvoiceId: invoice.id } });
  if (existing) return existing;
  const { plan, line } = paidInvoicePlan(invoice, metadata);
  const periodStart = dateFromUnix(line.period.start)!;
  const periodEnd = dateFromUnix(line.period.end)!;
  const processedAt = new Date();
  await ensurePromotionalGrant(tx, { workspaceId: account.workspaceId, now: processedAt });
  await expireStaleIncludedCredits(tx, { workspaceId: account.workspaceId, now: processedAt });
  const expired = periodEnd.getTime() <= processedAt.getTime();
  const period = await tx.billingSubscriptionPeriod.create({
    data: {
      workspaceId: account.workspaceId,
      billingAccountId: account.id,
      stripeSubscriptionId: subscriptionId,
      stripeInvoiceId: invoice.id,
      periodStart,
      periodEnd,
      includedCredits: BigInt(plan.credits),
      grantedAt: dateFromUnix(event.created) ?? processedAt,
      expiredAt: expired ? processedAt : null,
    },
  });
  if (expired) return period;
  const credit = await lockCreditAccount(tx, account.workspaceId);
  if (credit.includedAvailable !== 0n) {
    throw new AppError("conflict", "A new paid period overlaps unexpired included credits.");
  }
  const amount = BigInt(plan.credits);
  const updated = await tx.creditAccount.update({
    where: { id: credit.id },
    data: {
      includedAvailable: { increment: amount },
      includedSourcePeriodId: period.id,
      optimisticVersion: { increment: 1 },
    },
  });
  await tx.creditLedger.create({
    data: {
      workspaceId: account.workspaceId,
      creditAccountId: credit.id,
      subscriptionPeriodId: period.id,
      stripeEventId: event.id,
      type: "PERIOD_GRANT",
      bucket: "INCLUDED",
      amount,
      availableDelta: amount,
      heldDelta: 0n,
      balanceAfterAvailable: updated.includedAvailable,
      balanceAfterHeld: updated.includedHeld,
      idempotencyKey: `period-grant:${invoice.id}`,
      externalReference: `stripe-invoice:${invoice.id}`,
      occurredAt: dateFromUnix(event.created) ?? new Date(),
      metadata: { catalogKey: plan.key, periodEnd: periodEnd.toISOString() },
    },
  });
  await unblockCreditSchedules(tx, account.workspaceId);
  return period;
}

async function applyInvoiceEvent(tx: Prisma.TransactionClient, event: Stripe.Event) {
  const invoice = event.data.object as Stripe.Invoice;
  const { account, subscriptionId, metadata } = await resolveInvoiceAccount(tx, invoice);
  if (event.type === "invoice.paid") {
    const period = await grantIncludedCredits(tx, event, invoice, account, subscriptionId, metadata);
    const updateProjection = newerProjection(account, event);
    await tx.billingAccount.update({
      where: { id: account.id },
      data: {
        paidThroughAt: account.paidThroughAt && account.paidThroughAt > period.periodEnd
          ? account.paidThroughAt
          : period.periodEnd,
        ...(updateProjection
          ? {
              status: period.periodEnd.getTime() > Date.now() && !["CANCELED", "PAUSED"].includes(account.status)
                ? "ACTIVE"
                : account.status,
              currentPeriodStart: period.periodStart,
              currentPeriodEnd: period.periodEnd,
              lastStripeEventCreatedAt: dateFromUnix(event.created),
              lastStripeEventId: event.id,
            }
          : {}),
      },
    });
  } else if (newerProjection(account, event)) {
    await tx.billingAccount.update({
      where: { id: account.id },
      data: {
        status: "PAST_DUE",
        lastStripeEventCreatedAt: dateFromUnix(event.created),
        lastStripeEventId: event.id,
      },
    });
  }
  return account.workspaceId;
}

async function applyStripeEvent(tx: Prisma.TransactionClient, event: Stripe.Event): Promise<string | null> {
  switch (event.type as HandledStripeEventType) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded":
    case "checkout.session.async_payment_failed":
    case "checkout.session.expired":
      return applyCheckoutEvent(tx, event);
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted":
    case "customer.subscription.paused":
    case "customer.subscription.resumed":
      return applySubscriptionEvent(tx, event);
    case "invoice.paid":
    case "invoice.payment_failed":
    case "invoice.payment_action_required":
      return applyInvoiceEvent(tx, event);
    default:
      return null;
  }
}

async function recordFailedStripeEvent(event: Stripe.Event, payload: ReturnType<typeof eventPayload>, error: unknown) {
  const failureCode = error instanceof AppError ? error.code : "processing_failed";
  await serializable(async (tx) => {
    const existing = await tx.stripeEvent.findUnique({ where: { id: event.id } });
    if (existing?.payloadHash && existing.payloadHash !== payload.hash) throw new StripeEventPayloadCollisionError(event.id);
    if (existing?.status === "PROCESSED") return;
    await tx.stripeEvent.upsert({
      where: { id: event.id },
      create: {
        id: event.id,
        type: event.type,
        mode: event.livemode ? "LIVE" : "TEST",
        apiVersion: event.api_version,
        payloadHash: payload.hash,
        payload: payload.json,
        status: "FAILED",
        eventCreatedAt: dateFromUnix(event.created)!,
        processedAt: new Date(),
        failureCode,
        failureMessage: "Stripe event processing failed.",
      },
      update: {
        status: "FAILED",
        processedAt: new Date(),
        failureCode,
        failureMessage: "Stripe event processing failed.",
      },
    });
  });
}

export async function processStripeEvent(inputEvent: Stripe.Event) {
  requireBillingEnabled("summary");
  assertEventMode(inputEvent);
  const payload = eventPayload(inputEvent);
  const known = await getDb().stripeEvent.findUnique({ where: { id: inputEvent.id } });
  if (known) {
    if (known.payloadHash !== payload.hash) throw new StripeEventPayloadCollisionError(inputEvent.id);
    if (known.status === "PROCESSED") return { duplicate: true, handled: isHandledStripeEventType(inputEvent.type), workspaceId: known.workspaceId };
  }
  const event = await hydratedEvent(inputEvent);
  try {
    return await serializable(async (tx) => {
      await tx.stripeEvent.createMany({
        data: [{
          id: event.id,
          type: event.type,
          mode: event.livemode ? "LIVE" : "TEST",
          apiVersion: event.api_version,
          payloadHash: payload.hash,
          payload: payload.json,
          eventCreatedAt: dateFromUnix(event.created)!,
        }],
        skipDuplicates: true,
      });
      const existing = await tx.stripeEvent.findUniqueOrThrow({ where: { id: event.id } });
      if (existing.payloadHash !== payload.hash) throw new StripeEventPayloadCollisionError(event.id);
      if (existing.status === "PROCESSED") {
        return {
          duplicate: true,
          handled: isHandledStripeEventType(inputEvent.type),
          workspaceId: existing.workspaceId,
        };
      }
      const workspaceId = await applyStripeEvent(tx, event);
      await tx.stripeEvent.update({
        where: { id: event.id },
        data: {
          workspaceId,
          status: "PROCESSED",
          processedAt: new Date(),
          failureCode: null,
          failureMessage: null,
        },
      });
      return { duplicate: false, handled: workspaceId !== null, workspaceId };
    });
  } catch (error) {
    await recordFailedStripeEvent(event, payload, error).catch(() => undefined);
    throw error;
  }
}

export async function reconcileStripeBilling(input: { since?: Date; maxEvents?: number } = {}) {
  requireBillingEnabled("summary");
  const since = input.since ?? new Date(Date.now() - 3 * 24 * 60 * 60_000);
  const maxEvents = Math.min(Math.max(input.maxEvents ?? 500, 1), 1_000);
  const events = await stripeRequest("event reconciliation", () =>
    getStripeClient().events.list({
      created: { gte: Math.floor(since.getTime() / 1_000) },
      types: [...HANDLED_STRIPE_EVENT_TYPES],
      limit: 100,
    }).autoPagingToArray({ limit: maxEvents }),
  );
  events.sort((left, right) => left.created - right.created || left.id.localeCompare(right.id));
  let repaired = 0;
  for (const event of events) {
    const result = await processStripeEvent(event);
    if (!result.duplicate) repaired += 1;
  }

  const now = new Date();
  const workspaces = await getDb().creditAccount.findMany({ select: { workspaceId: true } });
  for (const { workspaceId } of workspaces) {
    await serializable(async (tx) => {
      await expireStaleIncludedCredits(tx, { workspaceId, now });
      await expireStalePurchasedCredits(tx, { workspaceId, now });
    });
  }

  const accounts = await getDb().billingAccount.findMany({
    where: { stripeSubscriptionId: { not: null } },
    select: { workspaceId: true, stripeSubscriptionId: true, status: true, catalogKey: true, stripePriceId: true },
  });
  const drift: Array<{ workspaceId: string; reason: string }> = [];
  for (const account of accounts) {
    try {
      const subscription = await stripeRequest("subscription reconciliation", () =>
        getStripeClient().subscriptions.retrieve(account.stripeSubscriptionId!),
      );
      const remote = subscriptionPlan(subscription);
      if (
        subscriptionStatus(subscription.status) !== account.status ||
        remote.plan.key !== account.catalogKey ||
        stripeId(remote.subscriptionItem.price) !== account.stripePriceId
      ) {
        drift.push({ workspaceId: account.workspaceId, reason: "subscription_projection_mismatch" });
      }
    } catch (error) {
      if (error instanceof IntegrationError && error.retryable) throw error;
      drift.push({ workspaceId: account.workspaceId, reason: "subscription_unavailable" });
    }
  }
  return { scannedEvents: events.length, repairedEvents: repaired, expiredPeriodAccounts: workspaces.length, drift };
}
