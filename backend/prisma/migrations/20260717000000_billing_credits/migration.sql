-- CreateEnum
CREATE TYPE "BillingTier" AS ENUM ('STARTER', 'BUILDER', 'SCALE');

-- CreateEnum
CREATE TYPE "BillingSubscriptionStatus" AS ENUM ('INACTIVE', 'INCOMPLETE', 'TRIALING', 'ACTIVE', 'PAST_DUE', 'PAUSED', 'CANCELED', 'UNPAID');

-- CreateEnum
CREATE TYPE "BillingCheckoutKind" AS ENUM ('SUBSCRIPTION', 'CREDIT_PACK');

-- CreateEnum
CREATE TYPE "BillingCheckoutStatus" AS ENUM ('PENDING', 'OPEN', 'COMPLETE', 'EXPIRED', 'FAILED');

-- CreateEnum
CREATE TYPE "CreditReservationStatus" AS ENUM ('HELD', 'SETTLED', 'RELEASED');

-- CreateEnum
CREATE TYPE "CreditBucket" AS ENUM ('INCLUDED', 'PROMOTIONAL', 'PURCHASED');

-- CreateEnum
CREATE TYPE "CreditLedgerType" AS ENUM ('PROMOTIONAL_GRANT', 'PERIOD_GRANT', 'PERIOD_EXPIRY', 'PURCHASE', 'PURCHASE_EXPIRY', 'HACKATHON_CODE_GRANT', 'HOLD', 'SETTLEMENT', 'RELEASE', 'ADJUSTMENT');

-- CreateEnum
CREATE TYPE "StripeEventMode" AS ENUM ('TEST', 'LIVE');

-- CreateEnum
CREATE TYPE "StripeEventStatus" AS ENUM ('RECEIVED', 'PROCESSED', 'FAILED');

-- AlterEnum
ALTER TYPE "ScheduleStatus" ADD VALUE 'BLOCKED';

-- AlterTable
ALTER TABLE "schedules" ADD COLUMN     "blockedAt" TIMESTAMPTZ(6),
ADD COLUMN     "blockerCode" VARCHAR(100),
ADD COLUMN     "blockerMessage" VARCHAR(500);

-- CreateTable
CREATE TABLE "billing_accounts" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "stripeCustomerId" VARCHAR(255),
    "stripeSubscriptionId" VARCHAR(255),
    "tier" "BillingTier",
    "catalogKey" VARCHAR(100),
    "stripePriceId" VARCHAR(255),
    "status" "BillingSubscriptionStatus" NOT NULL DEFAULT 'INACTIVE',
    "cancelAtPeriodEnd" BOOLEAN NOT NULL DEFAULT false,
    "currentPeriodStart" TIMESTAMPTZ(6),
    "currentPeriodEnd" TIMESTAMPTZ(6),
    "paidThroughAt" TIMESTAMPTZ(6),
    "lastStripeEventCreatedAt" TIMESTAMPTZ(6),
    "lastStripeEventId" VARCHAR(255),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "billing_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_checkout_sessions" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "billingAccountId" UUID,
    "kind" "BillingCheckoutKind" NOT NULL,
    "status" "BillingCheckoutStatus" NOT NULL DEFAULT 'PENDING',
    "catalogKey" VARCHAR(100) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "quotedAmountMinor" BIGINT NOT NULL,
    "quotedCredits" BIGINT NOT NULL DEFAULT 0,
    "integrationIdentifier" VARCHAR(100) NOT NULL,
    "requestIdempotencyKey" VARCHAR(200) NOT NULL,
    "stripeCheckoutSessionId" VARCHAR(255),
    "stripePaymentIntentId" VARCHAR(255),
    "stripeSubscriptionId" VARCHAR(255),
    "stripeCustomerId" VARCHAR(255),
    "expiresAt" TIMESTAMPTZ(6),
    "completedAt" TIMESTAMPTZ(6),
    "failedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "billing_checkout_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_subscription_periods" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "billingAccountId" UUID NOT NULL,
    "stripeSubscriptionId" VARCHAR(255) NOT NULL,
    "stripeInvoiceId" VARCHAR(255) NOT NULL,
    "periodStart" TIMESTAMPTZ(6) NOT NULL,
    "periodEnd" TIMESTAMPTZ(6) NOT NULL,
    "includedCredits" BIGINT NOT NULL,
    "grantedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiredAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "billing_subscription_periods_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit_accounts" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "promotionalAvailable" BIGINT NOT NULL DEFAULT 0,
    "promotionalHeld" BIGINT NOT NULL DEFAULT 0,
    "includedAvailable" BIGINT NOT NULL DEFAULT 0,
    "includedHeld" BIGINT NOT NULL DEFAULT 0,
    "purchasedAvailable" BIGINT NOT NULL DEFAULT 0,
    "purchasedHeld" BIGINT NOT NULL DEFAULT 0,
    "includedSourcePeriodId" UUID,
    "promotionalGrantedAt" TIMESTAMPTZ(6),
    "optimisticVersion" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "credit_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit_reservations" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "runId" UUID NOT NULL,
    "runAttempt" INTEGER NOT NULL,
    "creditAccountId" UUID NOT NULL,
    "includedSourcePeriodId" UUID,
    "operation" VARCHAR(50) NOT NULL,
    "pricingVersion" VARCHAR(50) NOT NULL,
    "quotedCredits" BIGINT NOT NULL,
    "includedCredits" BIGINT NOT NULL DEFAULT 0,
    "promotionalCredits" BIGINT NOT NULL DEFAULT 0,
    "purchasedCredits" BIGINT NOT NULL DEFAULT 0,
    "status" "CreditReservationStatus" NOT NULL DEFAULT 'HELD',
    "heldAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settledAt" TIMESTAMPTZ(6),
    "releasedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "credit_reservations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit_lots" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "creditAccountId" UUID NOT NULL,
    "checkoutSessionId" UUID,
    "stripeEventId" VARCHAR(255),
    "externalReference" VARCHAR(300) NOT NULL,
    "originalCredits" BIGINT NOT NULL,
    "availableCredits" BIGINT NOT NULL,
    "heldCredits" BIGINT NOT NULL DEFAULT 0,
    "purchasedAt" TIMESTAMPTZ(6) NOT NULL,
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "expiredAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "credit_lots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit_reservation_lot_allocations" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "reservationId" UUID NOT NULL,
    "creditLotId" UUID NOT NULL,
    "amount" BIGINT NOT NULL,

    CONSTRAINT "credit_reservation_lot_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit_codes" (
    "id" UUID NOT NULL,
    "codeHash" CHAR(64) NOT NULL,
    "displaySuffix" VARCHAR(8) NOT NULL,
    "label" VARCHAR(120) NOT NULL,
    "grantCredits" BIGINT NOT NULL,
    "maxRedemptions" INTEGER NOT NULL DEFAULT 1,
    "currentRedemptions" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "disabledAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "credit_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit_code_redemptions" (
    "id" UUID NOT NULL,
    "creditCodeId" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "userId" TEXT NOT NULL,
    "creditAccountId" UUID NOT NULL,
    "grantCredits" BIGINT NOT NULL,
    "idempotencyKey" VARCHAR(200) NOT NULL,
    "redeemedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "credit_code_redemptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit_ledger" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "creditAccountId" UUID NOT NULL,
    "reservationId" UUID,
    "subscriptionPeriodId" UUID,
    "checkoutSessionId" UUID,
    "creditLotId" UUID,
    "creditCodeRedemptionId" UUID,
    "stripeEventId" VARCHAR(255),
    "type" "CreditLedgerType" NOT NULL,
    "bucket" "CreditBucket" NOT NULL,
    "amount" BIGINT NOT NULL,
    "availableDelta" BIGINT NOT NULL,
    "heldDelta" BIGINT NOT NULL,
    "balanceAfterAvailable" BIGINT NOT NULL,
    "balanceAfterHeld" BIGINT NOT NULL,
    "idempotencyKey" VARCHAR(200) NOT NULL,
    "externalReference" VARCHAR(300),
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "occurredAt" TIMESTAMPTZ(6) NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "credit_ledger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stripe_events" (
    "id" VARCHAR(255) NOT NULL,
    "workspaceId" UUID,
    "type" VARCHAR(150) NOT NULL,
    "mode" "StripeEventMode" NOT NULL,
    "apiVersion" VARCHAR(50),
    "payloadHash" CHAR(64) NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "StripeEventStatus" NOT NULL DEFAULT 'RECEIVED',
    "eventCreatedAt" TIMESTAMPTZ(6) NOT NULL,
    "processedAt" TIMESTAMPTZ(6),
    "failureCode" VARCHAR(100),
    "failureMessage" VARCHAR(1000),
    "receivedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "stripe_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "billing_accounts_workspaceId_key" ON "billing_accounts"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "billing_accounts_stripeCustomerId_key" ON "billing_accounts"("stripeCustomerId");

-- CreateIndex
CREATE UNIQUE INDEX "billing_accounts_stripeSubscriptionId_key" ON "billing_accounts"("stripeSubscriptionId");

-- CreateIndex
CREATE INDEX "billing_accounts_status_paidThroughAt_idx" ON "billing_accounts"("status", "paidThroughAt");

-- CreateIndex
CREATE UNIQUE INDEX "billing_accounts_workspaceId_id_key" ON "billing_accounts"("workspaceId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "billing_checkout_sessions_integrationIdentifier_key" ON "billing_checkout_sessions"("integrationIdentifier");

-- CreateIndex
CREATE UNIQUE INDEX "billing_checkout_sessions_stripeCheckoutSessionId_key" ON "billing_checkout_sessions"("stripeCheckoutSessionId");

-- CreateIndex
CREATE UNIQUE INDEX "billing_checkout_sessions_stripePaymentIntentId_key" ON "billing_checkout_sessions"("stripePaymentIntentId");

-- CreateIndex
CREATE UNIQUE INDEX "billing_checkout_sessions_stripeSubscriptionId_key" ON "billing_checkout_sessions"("stripeSubscriptionId");

-- CreateIndex
CREATE INDEX "billing_checkout_sessions_workspaceId_status_createdAt_idx" ON "billing_checkout_sessions"("workspaceId", "status", "createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "billing_checkout_sessions_workspaceId_id_key" ON "billing_checkout_sessions"("workspaceId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "billing_checkout_sessions_workspaceId_requestIdempotencyKey_key" ON "billing_checkout_sessions"("workspaceId", "requestIdempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "billing_subscription_periods_stripeInvoiceId_key" ON "billing_subscription_periods"("stripeInvoiceId");

-- CreateIndex
CREATE INDEX "billing_subscription_periods_workspaceId_periodEnd_expiredA_idx" ON "billing_subscription_periods"("workspaceId", "periodEnd", "expiredAt");

-- CreateIndex
CREATE UNIQUE INDEX "billing_subscription_periods_workspaceId_id_key" ON "billing_subscription_periods"("workspaceId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "billing_subscription_periods_stripeSubscriptionId_periodSta_key" ON "billing_subscription_periods"("stripeSubscriptionId", "periodStart", "periodEnd");

-- CreateIndex
CREATE UNIQUE INDEX "credit_accounts_workspaceId_key" ON "credit_accounts"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "credit_accounts_workspaceId_id_key" ON "credit_accounts"("workspaceId", "id");

-- CreateIndex
CREATE INDEX "credit_reservations_workspaceId_status_heldAt_idx" ON "credit_reservations"("workspaceId", "status", "heldAt");

-- CreateIndex
CREATE UNIQUE INDEX "credit_reservations_workspaceId_id_key" ON "credit_reservations"("workspaceId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "credit_reservations_runId_runAttempt_key" ON "credit_reservations"("runId", "runAttempt");

-- CreateIndex
CREATE UNIQUE INDEX "credit_lots_checkoutSessionId_key" ON "credit_lots"("checkoutSessionId");

-- CreateIndex
CREATE UNIQUE INDEX "credit_lots_externalReference_key" ON "credit_lots"("externalReference");

-- CreateIndex
CREATE INDEX "credit_lots_workspaceId_expiresAt_expiredAt_idx" ON "credit_lots"("workspaceId", "expiresAt", "expiredAt");

-- CreateIndex
CREATE UNIQUE INDEX "credit_lots_workspaceId_id_key" ON "credit_lots"("workspaceId", "id");

-- CreateIndex
CREATE INDEX "credit_reservation_lot_allocations_creditLotId_idx" ON "credit_reservation_lot_allocations"("creditLotId");

-- CreateIndex
CREATE UNIQUE INDEX "credit_reservation_lot_allocations_reservationId_creditLotI_key" ON "credit_reservation_lot_allocations"("reservationId", "creditLotId");

-- CreateIndex
CREATE UNIQUE INDEX "credit_codes_codeHash_key" ON "credit_codes"("codeHash");

-- CreateIndex
CREATE INDEX "credit_codes_expiresAt_disabledAt_idx" ON "credit_codes"("expiresAt", "disabledAt");

-- CreateIndex
CREATE INDEX "credit_code_redemptions_workspaceId_redeemedAt_idx" ON "credit_code_redemptions"("workspaceId", "redeemedAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "credit_code_redemptions_workspaceId_id_key" ON "credit_code_redemptions"("workspaceId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "credit_code_redemptions_creditCodeId_workspaceId_key" ON "credit_code_redemptions"("creditCodeId", "workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "credit_code_redemptions_workspaceId_idempotencyKey_key" ON "credit_code_redemptions"("workspaceId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "credit_ledger_externalReference_key" ON "credit_ledger"("externalReference");

-- CreateIndex
CREATE INDEX "credit_ledger_workspaceId_occurredAt_idx" ON "credit_ledger"("workspaceId", "occurredAt" DESC);

-- CreateIndex
CREATE INDEX "credit_ledger_reservationId_idx" ON "credit_ledger"("reservationId");

-- CreateIndex
CREATE UNIQUE INDEX "credit_ledger_workspaceId_id_key" ON "credit_ledger"("workspaceId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "credit_ledger_workspaceId_idempotencyKey_key" ON "credit_ledger"("workspaceId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "stripe_events_workspaceId_status_receivedAt_idx" ON "stripe_events"("workspaceId", "status", "receivedAt");

-- CreateIndex
CREATE INDEX "stripe_events_status_receivedAt_idx" ON "stripe_events"("status", "receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "users_workspaceId_id_key" ON "users"("workspaceId", "id");

-- AddForeignKey
ALTER TABLE "billing_accounts" ADD CONSTRAINT "billing_accounts_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_checkout_sessions" ADD CONSTRAINT "billing_checkout_sessions_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_checkout_sessions" ADD CONSTRAINT "billing_checkout_sessions_workspaceId_billingAccountId_fkey" FOREIGN KEY ("workspaceId", "billingAccountId") REFERENCES "billing_accounts"("workspaceId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_subscription_periods" ADD CONSTRAINT "billing_subscription_periods_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_subscription_periods" ADD CONSTRAINT "billing_subscription_periods_workspaceId_billingAccountId_fkey" FOREIGN KEY ("workspaceId", "billingAccountId") REFERENCES "billing_accounts"("workspaceId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_accounts" ADD CONSTRAINT "credit_accounts_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_accounts" ADD CONSTRAINT "credit_accounts_workspaceId_includedSourcePeriodId_fkey" FOREIGN KEY ("workspaceId", "includedSourcePeriodId") REFERENCES "billing_subscription_periods"("workspaceId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_reservations" ADD CONSTRAINT "credit_reservations_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_reservations" ADD CONSTRAINT "credit_reservations_workspaceId_projectId_runId_fkey" FOREIGN KEY ("workspaceId", "projectId", "runId") REFERENCES "workflow_runs"("workspaceId", "projectId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_reservations" ADD CONSTRAINT "credit_reservations_workspaceId_creditAccountId_fkey" FOREIGN KEY ("workspaceId", "creditAccountId") REFERENCES "credit_accounts"("workspaceId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_reservations" ADD CONSTRAINT "credit_reservations_workspaceId_includedSourcePeriodId_fkey" FOREIGN KEY ("workspaceId", "includedSourcePeriodId") REFERENCES "billing_subscription_periods"("workspaceId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_lots" ADD CONSTRAINT "credit_lots_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_lots" ADD CONSTRAINT "credit_lots_workspaceId_creditAccountId_fkey" FOREIGN KEY ("workspaceId", "creditAccountId") REFERENCES "credit_accounts"("workspaceId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_lots" ADD CONSTRAINT "credit_lots_workspaceId_checkoutSessionId_fkey" FOREIGN KEY ("workspaceId", "checkoutSessionId") REFERENCES "billing_checkout_sessions"("workspaceId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_lots" ADD CONSTRAINT "credit_lots_stripeEventId_fkey" FOREIGN KEY ("stripeEventId") REFERENCES "stripe_events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_reservation_lot_allocations" ADD CONSTRAINT "credit_reservation_lot_allocations_workspaceId_reservation_fkey" FOREIGN KEY ("workspaceId", "reservationId") REFERENCES "credit_reservations"("workspaceId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_reservation_lot_allocations" ADD CONSTRAINT "credit_reservation_lot_allocations_workspaceId_creditLotId_fkey" FOREIGN KEY ("workspaceId", "creditLotId") REFERENCES "credit_lots"("workspaceId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_code_redemptions" ADD CONSTRAINT "credit_code_redemptions_creditCodeId_fkey" FOREIGN KEY ("creditCodeId") REFERENCES "credit_codes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_code_redemptions" ADD CONSTRAINT "credit_code_redemptions_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_code_redemptions" ADD CONSTRAINT "credit_code_redemptions_workspaceId_userId_fkey" FOREIGN KEY ("workspaceId", "userId") REFERENCES "users"("workspaceId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_code_redemptions" ADD CONSTRAINT "credit_code_redemptions_workspaceId_creditAccountId_fkey" FOREIGN KEY ("workspaceId", "creditAccountId") REFERENCES "credit_accounts"("workspaceId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_workspaceId_creditAccountId_fkey" FOREIGN KEY ("workspaceId", "creditAccountId") REFERENCES "credit_accounts"("workspaceId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_workspaceId_reservationId_fkey" FOREIGN KEY ("workspaceId", "reservationId") REFERENCES "credit_reservations"("workspaceId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_workspaceId_subscriptionPeriodId_fkey" FOREIGN KEY ("workspaceId", "subscriptionPeriodId") REFERENCES "billing_subscription_periods"("workspaceId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_workspaceId_checkoutSessionId_fkey" FOREIGN KEY ("workspaceId", "checkoutSessionId") REFERENCES "billing_checkout_sessions"("workspaceId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_workspaceId_creditLotId_fkey" FOREIGN KEY ("workspaceId", "creditLotId") REFERENCES "credit_lots"("workspaceId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_workspaceId_creditCodeRedemptionId_fkey" FOREIGN KEY ("workspaceId", "creditCodeRedemptionId") REFERENCES "credit_code_redemptions"("workspaceId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_stripeEventId_fkey" FOREIGN KEY ("stripeEventId") REFERENCES "stripe_events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stripe_events" ADD CONSTRAINT "stripe_events_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Financial invariants
ALTER TABLE "schedules" ADD CONSTRAINT "schedule_credit_blocker_consistency" CHECK (
    ("status" = 'BLOCKED' AND "blockerCode" = 'insufficient_credits' AND "blockedAt" IS NOT NULL AND "backoffUntil" IS NULL)
    OR
    ("status" <> 'BLOCKED' AND "blockerCode" IS NULL AND "blockerMessage" IS NULL AND "blockedAt" IS NULL)
);

ALTER TABLE "billing_checkout_sessions" ADD CONSTRAINT "billing_checkout_quote_nonnegative" CHECK (
    "quotedAmountMinor" >= 0 AND "quotedCredits" >= 0
);
ALTER TABLE "billing_subscription_periods" ADD CONSTRAINT "billing_period_is_valid" CHECK (
    "includedCredits" > 0 AND "periodEnd" > "periodStart" AND ("expiredAt" IS NULL OR "expiredAt" >= "periodEnd")
);

ALTER TABLE "credit_accounts" ADD CONSTRAINT "credit_account_balances_nonnegative" CHECK (
    "promotionalAvailable" >= 0 AND "promotionalHeld" >= 0
    AND "includedAvailable" >= 0 AND "includedHeld" >= 0
    AND "purchasedAvailable" >= 0 AND "purchasedHeld" >= 0
    AND "optimisticVersion" >= 0
);
ALTER TABLE "credit_accounts" ADD CONSTRAINT "included_available_has_source_period" CHECK (
    "includedAvailable" = 0 OR "includedSourcePeriodId" IS NOT NULL
);

ALTER TABLE "credit_reservations" ADD CONSTRAINT "credit_reservation_amounts_nonnegative" CHECK (
    "runAttempt" >= 1 AND "quotedCredits" >= 0
    AND "includedCredits" >= 0 AND "promotionalCredits" >= 0 AND "purchasedCredits" >= 0
);
ALTER TABLE "credit_reservations" ADD CONSTRAINT "credit_reservation_allocation_matches_quote" CHECK (
    "includedCredits" + "promotionalCredits" + "purchasedCredits" = "quotedCredits"
);
ALTER TABLE "credit_reservations" ADD CONSTRAINT "credit_reservation_included_source_consistency" CHECK (
    ("includedCredits" = 0 AND "includedSourcePeriodId" IS NULL)
    OR ("includedCredits" > 0 AND "includedSourcePeriodId" IS NOT NULL)
);
ALTER TABLE "credit_reservations" ADD CONSTRAINT "credit_reservation_terminal_timestamps" CHECK (
    ("status" = 'HELD' AND "settledAt" IS NULL AND "releasedAt" IS NULL)
    OR ("status" = 'SETTLED' AND "settledAt" IS NOT NULL AND "releasedAt" IS NULL)
    OR ("status" = 'RELEASED' AND "settledAt" IS NULL AND "releasedAt" IS NOT NULL)
);

ALTER TABLE "credit_lots" ADD CONSTRAINT "credit_lot_balances_and_expiry_valid" CHECK (
    "originalCredits" > 0 AND "availableCredits" >= 0 AND "heldCredits" >= 0
    AND "availableCredits" + "heldCredits" <= "originalCredits"
    AND "expiresAt" > "purchasedAt"
    AND ("expiredAt" IS NULL OR "expiredAt" >= "expiresAt")
);
ALTER TABLE "credit_reservation_lot_allocations" ADD CONSTRAINT "credit_lot_allocation_positive" CHECK ("amount" > 0);

ALTER TABLE "credit_codes" ADD CONSTRAINT "credit_code_is_valid" CHECK (
    "codeHash" ~ '^[0-9a-f]{64}$'
    AND char_length("displaySuffix") BETWEEN 4 AND 8
    AND "grantCredits" > 0
    AND "maxRedemptions" >= 1
    AND "currentRedemptions" >= 0
    AND "currentRedemptions" <= "maxRedemptions"
    AND "expiresAt" > "createdAt"
);
ALTER TABLE "credit_code_redemptions" ADD CONSTRAINT "credit_code_redemption_grant_positive" CHECK ("grantCredits" > 0);

ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_amount_and_balances_valid" CHECK (
    "amount" > 0 AND "balanceAfterAvailable" >= 0 AND "balanceAfterHeld" >= 0
    AND ("availableDelta" <> 0 OR "heldDelta" <> 0)
);

-- Credit history is corrected only by appending audited entries.
CREATE FUNCTION reject_credit_ledger_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'credit_ledger is append-only; append an adjustment instead'
        USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER credit_ledger_append_only
BEFORE UPDATE OR DELETE ON "credit_ledger"
FOR EACH ROW EXECUTE FUNCTION reject_credit_ledger_mutation();
