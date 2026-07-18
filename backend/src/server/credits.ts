import "server-only";

import {
  Prisma,
  type CreditAccount,
  type CreditBucket,
  type CreditLot,
  type CreditReservation,
  type CreditReservationLotAllocation,
} from "@prisma/client";

import { CREDIT_PRICING_VERSION, quoteCreditOperation, type CreditOperation } from "./credit-pricing";
import { creditCodeSuffix, hashCreditCode, normalizeCreditCode } from "./credit-codes";
import { AppError, InsufficientCreditsError } from "./errors";

export const PROMOTIONAL_GRANT_CREDITS = 100n;
export const PURCHASED_CREDIT_EXPIRY_MONTHS = 6;

export function normalizeHackathonCreditCode(code: string): string {
  return normalizeCreditCode(code);
}

export function hashHackathonCreditCode(code: string, hashSecret: string): string {
  return hashCreditCode(code, hashSecret);
}

export function hackathonCreditCodeSuffix(code: string): string {
  return creditCodeSuffix(code);
}

export interface CreditAllocation {
  included: bigint;
  promotional: bigint;
  purchased: bigint;
}

export interface PurchasedLotAllocation {
  creditLotId: string;
  amount: bigint;
  expiresAt: Date;
}

type LotAllocationWithLot = CreditReservationLotAllocation & { creditLot: CreditLot };

function min(left: bigint, right: bigint): bigint {
  return left < right ? left : right;
}

export function purchasedCreditsExpireAt(purchasedAt: Date): Date {
  const year = purchasedAt.getUTCFullYear();
  const targetMonth = purchasedAt.getUTCMonth() + PURCHASED_CREDIT_EXPIRY_MONTHS;
  const targetYear = year + Math.floor(targetMonth / 12);
  const month = targetMonth % 12;
  const lastDay = new Date(Date.UTC(targetYear, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(
    targetYear,
    month,
    Math.min(purchasedAt.getUTCDate(), lastDay),
    purchasedAt.getUTCHours(),
    purchasedAt.getUTCMinutes(),
    purchasedAt.getUTCSeconds(),
    purchasedAt.getUTCMilliseconds(),
  ));
}

export function allocateCreditBuckets(input: {
  required: bigint;
  included: bigint;
  promotional: bigint;
  purchased: bigint;
  purchasedSpendable?: boolean;
}): CreditAllocation {
  if (input.required < 0n || input.included < 0n || input.promotional < 0n || input.purchased < 0n) {
    throw new RangeError("Credit amounts cannot be negative.");
  }

  const spendable = input.included + input.promotional + input.purchased;
  if (spendable < input.required) {
    throw new InsufficientCreditsError({ required: input.required, spendable, frozen: 0n });
  }

  const included = min(input.required, input.included);
  const afterIncluded = input.required - included;
  const promotional = min(afterIncluded, input.promotional);
  return { included, promotional, purchased: afterIncluded - promotional };
}

export function allocatePurchasedCreditLots(
  lots: ReadonlyArray<Pick<CreditLot, "id" | "availableCredits" | "expiresAt">>,
  required: bigint,
): PurchasedLotAllocation[] {
  if (required < 0n) throw new RangeError("Purchased credit allocation cannot be negative.");
  let remaining = required;
  const allocations: PurchasedLotAllocation[] = [];
  const ordered = [...lots].sort((left, right) => {
    const expiry = left.expiresAt.getTime() - right.expiresAt.getTime();
    return expiry || left.id.localeCompare(right.id);
  });
  for (const lot of ordered) {
    if (remaining === 0n) break;
    if (lot.availableCredits <= 0n) continue;
    const amount = min(remaining, lot.availableCredits);
    allocations.push({ creditLotId: lot.id, amount, expiresAt: lot.expiresAt });
    remaining -= amount;
  }
  if (remaining > 0n) {
    throw new AppError("internal_error", "Purchased credit lots do not match the account balance");
  }
  return allocations;
}

export function creditBalanceSummary(
  account: Pick<
    CreditAccount,
    | "includedAvailable"
    | "includedHeld"
    | "promotionalAvailable"
    | "promotionalHeld"
    | "purchasedAvailable"
    | "purchasedHeld"
  >,
  purchasedSpendable?: boolean,
) {
  void purchasedSpendable;
  return {
    spendable: account.includedAvailable + account.promotionalAvailable + account.purchasedAvailable,
    held: account.includedHeld + account.promotionalHeld + account.purchasedHeld,
    frozen: 0n,
  };
}

async function ensureAccount(tx: Prisma.TransactionClient, workspaceId: string): Promise<void> {
  await tx.creditAccount.upsert({ where: { workspaceId }, create: { workspaceId }, update: {} });
}

async function lockAccount(tx: Prisma.TransactionClient, workspaceId: string): Promise<CreditAccount> {
  await tx.$queryRaw(Prisma.sql`
    SELECT "id" FROM "credit_accounts"
    WHERE "workspaceId" = ${workspaceId}::uuid
    FOR UPDATE
  `);
  return tx.creditAccount.findUniqueOrThrow({ where: { workspaceId } });
}

function bucketBalances(account: CreditAccount, bucket: CreditBucket) {
  switch (bucket) {
    case "INCLUDED":
      return { available: account.includedAvailable, held: account.includedHeld };
    case "PROMOTIONAL":
      return { available: account.promotionalAvailable, held: account.promotionalHeld };
    case "PURCHASED":
      return { available: account.purchasedAvailable, held: account.purchasedHeld };
  }
}

export async function ensurePromotionalGrant(
  tx: Prisma.TransactionClient,
  input: { workspaceId: string; now?: Date },
): Promise<{ account: CreditAccount; granted: boolean }> {
  const now = input.now ?? new Date();
  await ensureAccount(tx, input.workspaceId);
  const account = await lockAccount(tx, input.workspaceId);
  if (account.promotionalGrantedAt) return { account, granted: false };

  const updated = await tx.creditAccount.update({
    where: { id: account.id },
    data: {
      promotionalAvailable: { increment: PROMOTIONAL_GRANT_CREDITS },
      promotionalGrantedAt: now,
      optimisticVersion: { increment: 1 },
    },
  });
  await tx.creditLedger.create({
    data: {
      workspaceId: input.workspaceId,
      creditAccountId: updated.id,
      type: "PROMOTIONAL_GRANT",
      bucket: "PROMOTIONAL",
      amount: PROMOTIONAL_GRANT_CREDITS,
      availableDelta: PROMOTIONAL_GRANT_CREDITS,
      heldDelta: 0n,
      balanceAfterAvailable: updated.promotionalAvailable,
      balanceAfterHeld: updated.promotionalHeld,
      idempotencyKey: `promotional-grant:${input.workspaceId}:v1`,
      occurredAt: now,
      metadata: { grantVersion: 1 },
    },
  });
  return { account: updated, granted: true };
}

export async function redeemCreditCode(
  tx: Prisma.TransactionClient,
  input: {
    workspaceId: string;
    userId: string;
    code: string;
    hashSecret: string;
    purpose: "hackathon" | "owner";
    now?: Date;
  },
) {
  const now = input.now ?? new Date();
  const codeHash = hashCreditCode(input.code, input.hashSecret);
  const user = await tx.user.findUnique({
    where: { workspaceId_id: { workspaceId: input.workspaceId, id: input.userId } },
    select: { id: true },
  });
  if (!user) throw new AppError("forbidden", "The credit code cannot be redeemed for this workspace");

  const initial = await tx.creditCode.findUnique({ where: { codeHash } });
  if (!initial) throw new AppError("bad_request", "The credit code is invalid or unavailable");
  await tx.$queryRaw(Prisma.sql`
    SELECT "id" FROM "credit_codes"
    WHERE "id" = ${initial.id}::uuid
    FOR UPDATE
  `);
  const creditCode = await tx.creditCode.findUniqueOrThrow({ where: { id: initial.id } });
  const existing = await tx.creditCodeRedemption.findUnique({
    where: { creditCodeId_workspaceId: { creditCodeId: creditCode.id, workspaceId: input.workspaceId } },
  });
  if (existing) {
    if (existing.userId !== input.userId) {
      throw new AppError("conflict", "The credit code was already redeemed for this workspace");
    }
    const account = await tx.creditAccount.findUniqueOrThrow({ where: { id: existing.creditAccountId } });
    return { account, redemption: existing, granted: false };
  }
  if (
    creditCode.disabledAt
    || creditCode.expiresAt.getTime() <= now.getTime()
    || creditCode.currentRedemptions >= creditCode.maxRedemptions
  ) {
    throw new AppError("bad_request", "The credit code is invalid or unavailable");
  }

  await ensureAccount(tx, input.workspaceId);
  let account = await lockAccount(tx, input.workspaceId);
  const replay = await tx.creditCodeRedemption.findUnique({
    where: { creditCodeId_workspaceId: { creditCodeId: creditCode.id, workspaceId: input.workspaceId } },
  });
  if (replay) {
    if (replay.userId !== input.userId) {
      throw new AppError("conflict", "The credit code was already redeemed for this workspace");
    }
    return { account, redemption: replay, granted: false };
  }

  const idempotencyKey = `${input.purpose}-code:${creditCode.id}:${input.workspaceId}`;
  const redemption = await tx.creditCodeRedemption.create({
    data: {
      creditCodeId: creditCode.id,
      workspaceId: input.workspaceId,
      userId: input.userId,
      creditAccountId: account.id,
      grantCredits: creditCode.grantCredits,
      idempotencyKey,
      redeemedAt: now,
    },
  });
  await tx.creditCode.update({
    where: { id: creditCode.id },
    data: { currentRedemptions: { increment: 1 } },
  });
  account = await tx.creditAccount.update({
    where: { id: account.id },
    data: {
      promotionalAvailable: { increment: creditCode.grantCredits },
      optimisticVersion: { increment: 1 },
    },
  });
  await tx.creditLedger.create({
    data: {
      workspaceId: input.workspaceId,
      creditAccountId: account.id,
      creditCodeRedemptionId: redemption.id,
      type: input.purpose === "owner" ? "PROMOTIONAL_GRANT" : "HACKATHON_CODE_GRANT",
      bucket: "PROMOTIONAL",
      amount: creditCode.grantCredits,
      availableDelta: creditCode.grantCredits,
      heldDelta: 0n,
      balanceAfterAvailable: account.promotionalAvailable,
      balanceAfterHeld: account.promotionalHeld,
      idempotencyKey,
      occurredAt: now,
      metadata: { label: creditCode.label, displaySuffix: creditCode.displaySuffix, purpose: input.purpose },
    },
  });
  return { account, redemption, granted: true };
}

export function redeemHackathonCreditCode(
  tx: Prisma.TransactionClient,
  input: Omit<Parameters<typeof redeemCreditCode>[1], "purpose">,
) {
  return redeemCreditCode(tx, { ...input, purpose: "hackathon" });
}

export async function grantPurchasedCredits(
  tx: Prisma.TransactionClient,
  input: {
    workspaceId: string;
    credits: bigint;
    externalReference: string;
    checkoutSessionId?: string;
    stripeEventId?: string;
    purchasedAt?: Date;
  },
): Promise<{ account: CreditAccount; lot: CreditLot; granted: boolean }> {
  if (input.credits < 1n) throw new AppError("bad_request", "A positive purchased credit grant is required");
  const purchasedAt = input.purchasedAt ?? new Date();
  const existing = await tx.creditLot.findUnique({ where: { externalReference: input.externalReference } });
  if (existing) {
    if (existing.workspaceId !== input.workspaceId || existing.originalCredits !== input.credits) {
      throw new AppError("conflict", "The purchase reference was already used for a different credit grant");
    }
    const account = await tx.creditAccount.findUniqueOrThrow({ where: { id: existing.creditAccountId } });
    return { account, lot: existing, granted: false };
  }

  await ensureAccount(tx, input.workspaceId);
  let account = await lockAccount(tx, input.workspaceId);
  const replay = await tx.creditLot.findUnique({ where: { externalReference: input.externalReference } });
  if (replay) {
    if (replay.workspaceId !== input.workspaceId || replay.originalCredits !== input.credits) {
      throw new AppError("conflict", "The purchase reference was already used for a different credit grant");
    }
    return { account, lot: replay, granted: false };
  }

  const lot = await tx.creditLot.create({
    data: {
      workspaceId: input.workspaceId,
      creditAccountId: account.id,
      ...(input.checkoutSessionId === undefined ? {} : { checkoutSessionId: input.checkoutSessionId }),
      ...(input.stripeEventId === undefined ? {} : { stripeEventId: input.stripeEventId }),
      externalReference: input.externalReference,
      originalCredits: input.credits,
      availableCredits: input.credits,
      purchasedAt,
      expiresAt: purchasedCreditsExpireAt(purchasedAt),
    },
  });
  account = await tx.creditAccount.update({
    where: { id: account.id },
    data: { purchasedAvailable: { increment: input.credits }, optimisticVersion: { increment: 1 } },
  });
  await tx.creditLedger.create({
    data: {
      workspaceId: input.workspaceId,
      creditAccountId: account.id,
      ...(input.checkoutSessionId === undefined ? {} : { checkoutSessionId: input.checkoutSessionId }),
      creditLotId: lot.id,
      ...(input.stripeEventId === undefined ? {} : { stripeEventId: input.stripeEventId }),
      type: "PURCHASE",
      bucket: "PURCHASED",
      amount: input.credits,
      availableDelta: input.credits,
      heldDelta: 0n,
      balanceAfterAvailable: account.purchasedAvailable,
      balanceAfterHeld: account.purchasedHeld,
      idempotencyKey: `credit-purchase:${input.externalReference}`,
      externalReference: input.externalReference,
      occurredAt: purchasedAt,
      metadata: { expiresAt: lot.expiresAt.toISOString() },
    },
  });
  return { account, lot, granted: true };
}

export async function expireStaleIncludedCredits(
  tx: Prisma.TransactionClient,
  input: { workspaceId: string; now?: Date },
): Promise<{ account: CreditAccount; expired: bigint }> {
  const now = input.now ?? new Date();
  await ensureAccount(tx, input.workspaceId);
  let account = await lockAccount(tx, input.workspaceId);
  if (!account.includedSourcePeriodId) {
    if (account.includedAvailable > 0n) throw new AppError("internal_error", "Included credits are missing their source period");
    return { account, expired: 0n };
  }

  const period = await tx.billingSubscriptionPeriod.findUnique({ where: { id: account.includedSourcePeriodId } });
  if (!period || period.workspaceId !== input.workspaceId) {
    throw new AppError("internal_error", "Included credits reference an invalid subscription period");
  }
  if (period.periodEnd.getTime() > now.getTime()) return { account, expired: 0n };

  const expired = account.includedAvailable;
  account = await tx.creditAccount.update({
    where: { id: account.id },
    data: { includedAvailable: 0n, includedSourcePeriodId: null, optimisticVersion: { increment: 1 } },
  });
  await tx.billingSubscriptionPeriod.updateMany({ where: { id: period.id, expiredAt: null }, data: { expiredAt: now } });
  if (expired > 0n) {
    await tx.creditLedger.create({
      data: {
        workspaceId: input.workspaceId,
        creditAccountId: account.id,
        subscriptionPeriodId: period.id,
        type: "PERIOD_EXPIRY",
        bucket: "INCLUDED",
        amount: expired,
        availableDelta: -expired,
        heldDelta: 0n,
        balanceAfterAvailable: account.includedAvailable,
        balanceAfterHeld: account.includedHeld,
        idempotencyKey: `period-expiry:${period.id}:available`,
        occurredAt: now,
      },
    });
  }
  return { account, expired };
}

export async function expireStalePurchasedCredits(
  tx: Prisma.TransactionClient,
  input: { workspaceId: string; now?: Date },
): Promise<{ account: CreditAccount; expired: bigint; lotCount: number }> {
  const now = input.now ?? new Date();
  await ensureAccount(tx, input.workspaceId);
  let account = await lockAccount(tx, input.workspaceId);
  const locked = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id" FROM "credit_lots"
    WHERE "workspaceId" = ${input.workspaceId}::uuid
      AND "expiresAt" <= ${now}
      AND "expiredAt" IS NULL
    ORDER BY "expiresAt", "id"
    FOR UPDATE
  `);
  if (locked.length === 0) return { account, expired: 0n, lotCount: 0 };

  const lots = await tx.creditLot.findMany({ where: { id: { in: locked.map(({ id }) => id) } } });
  const expired = lots.reduce((total, lot) => total + lot.availableCredits, 0n);
  if (account.purchasedAvailable < expired) {
    throw new AppError("internal_error", "Purchased credit lots exceed the account balance");
  }
  for (const lot of lots) {
    await tx.creditLot.update({ where: { id: lot.id }, data: { availableCredits: 0n, expiredAt: now } });
  }
  if (expired > 0n) {
    account = await tx.creditAccount.update({
      where: { id: account.id },
      data: { purchasedAvailable: { decrement: expired }, optimisticVersion: { increment: 1 } },
    });
    for (const lot of lots) {
      if (lot.availableCredits === 0n) continue;
      await tx.creditLedger.create({
        data: {
          workspaceId: input.workspaceId,
          creditAccountId: account.id,
          creditLotId: lot.id,
          type: "PURCHASE_EXPIRY",
          bucket: "PURCHASED",
          amount: lot.availableCredits,
          availableDelta: -lot.availableCredits,
          heldDelta: 0n,
          balanceAfterAvailable: account.purchasedAvailable,
          balanceAfterHeld: account.purchasedHeld,
          idempotencyKey: `credit-lot:${lot.id}:expiry:available`,
          occurredAt: now,
        },
      });
    }
  }
  return { account, expired, lotCount: lots.length };
}

function assertMatchingReservation(
  reservation: CreditReservation,
  input: { workspaceId: string; projectId: string; runId: string; runAttempt: number; operation: CreditOperation },
): void {
  if (
    reservation.workspaceId !== input.workspaceId
    || reservation.projectId !== input.projectId
    || reservation.runId !== input.runId
    || reservation.runAttempt !== input.runAttempt
    || reservation.operation !== input.operation
    || reservation.pricingVersion !== CREDIT_PRICING_VERSION
  ) {
    throw new AppError("conflict", "The workflow attempt already has a different credit quote");
  }
}

async function lockSpendablePurchasedLots(
  tx: Prisma.TransactionClient,
  input: { workspaceId: string; creditAccountId: string; now: Date },
): Promise<CreditLot[]> {
  const locked = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id" FROM "credit_lots"
    WHERE "workspaceId" = ${input.workspaceId}::uuid
      AND "creditAccountId" = ${input.creditAccountId}::uuid
      AND "availableCredits" > 0
      AND "expiresAt" > ${input.now}
      AND "expiredAt" IS NULL
    ORDER BY "expiresAt", "createdAt", "id"
    FOR UPDATE
  `);
  if (locked.length === 0) return [];
  const positions = new Map(locked.map(({ id }, index) => [id, index]));
  const lots = await tx.creditLot.findMany({ where: { id: { in: locked.map(({ id }) => id) } } });
  return lots.sort((left, right) => (positions.get(left.id) ?? 0) - (positions.get(right.id) ?? 0));
}

export async function reserveCredits(
  tx: Prisma.TransactionClient,
  input: {
    workspaceId: string;
    projectId: string;
    runId: string;
    runAttempt: number;
    operation: CreditOperation;
    now?: Date;
  },
): Promise<{ reservation: CreditReservation; replayed: boolean }> {
  if (!Number.isInteger(input.runAttempt) || input.runAttempt < 1) {
    throw new AppError("bad_request", "A positive workflow run attempt is required");
  }
  const existing = await tx.creditReservation.findUnique({
    where: { runId_runAttempt: { runId: input.runId, runAttempt: input.runAttempt } },
  });
  if (existing) {
    assertMatchingReservation(existing, input);
    return { reservation: existing, replayed: true };
  }

  const now = input.now ?? new Date();
  await ensurePromotionalGrant(tx, { workspaceId: input.workspaceId, now });
  await expireStaleIncludedCredits(tx, { workspaceId: input.workspaceId, now });
  let account = (await expireStalePurchasedCredits(tx, { workspaceId: input.workspaceId, now })).account;
  const quote = quoteCreditOperation(input.operation);
  const allocation = allocateCreditBuckets({
    required: quote.credits,
    included: account.includedAvailable,
    promotional: account.promotionalAvailable,
    purchased: account.purchasedAvailable,
  });
  const purchasedLots = allocation.purchased > 0n
    ? await lockSpendablePurchasedLots(tx, { workspaceId: input.workspaceId, creditAccountId: account.id, now })
    : [];
  const lotAllocations = allocatePurchasedCreditLots(purchasedLots, allocation.purchased);

  if (quote.credits > 0n) {
    account = await tx.creditAccount.update({
      where: { id: account.id },
      data: {
        includedAvailable: { decrement: allocation.included },
        includedHeld: { increment: allocation.included },
        promotionalAvailable: { decrement: allocation.promotional },
        promotionalHeld: { increment: allocation.promotional },
        purchasedAvailable: { decrement: allocation.purchased },
        purchasedHeld: { increment: allocation.purchased },
        optimisticVersion: { increment: 1 },
      },
    });
  }

  const reservation = await tx.creditReservation.create({
    data: {
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      runId: input.runId,
      runAttempt: input.runAttempt,
      creditAccountId: account.id,
      includedSourcePeriodId: allocation.included > 0n ? account.includedSourcePeriodId : null,
      operation: quote.operation,
      pricingVersion: quote.pricingVersion,
      quotedCredits: quote.credits,
      includedCredits: allocation.included,
      promotionalCredits: allocation.promotional,
      purchasedCredits: allocation.purchased,
      heldAt: now,
    },
  });

  for (const allocationForLot of lotAllocations) {
    await tx.creditLot.update({
      where: { id: allocationForLot.creditLotId },
      data: { availableCredits: { decrement: allocationForLot.amount }, heldCredits: { increment: allocationForLot.amount } },
    });
    await tx.creditReservationLotAllocation.create({
      data: {
        workspaceId: input.workspaceId,
        reservationId: reservation.id,
        creditLotId: allocationForLot.creditLotId,
        amount: allocationForLot.amount,
      },
    });
  }

  for (const [bucket, amount] of [
    ["INCLUDED", allocation.included],
    ["PROMOTIONAL", allocation.promotional],
  ] as const) {
    if (amount === 0n) continue;
    const balances = bucketBalances(account, bucket);
    await tx.creditLedger.create({
      data: {
        workspaceId: input.workspaceId,
        creditAccountId: account.id,
        reservationId: reservation.id,
        subscriptionPeriodId: bucket === "INCLUDED" ? reservation.includedSourcePeriodId : null,
        type: "HOLD",
        bucket,
        amount,
        availableDelta: -amount,
        heldDelta: amount,
        balanceAfterAvailable: balances.available,
        balanceAfterHeld: balances.held,
        idempotencyKey: `reservation:${reservation.id}:hold:${bucket.toLowerCase()}`,
        occurredAt: now,
        metadata: { operation: quote.operation, pricingVersion: quote.pricingVersion },
      },
    });
  }
  for (const lotAllocation of lotAllocations) {
    await tx.creditLedger.create({
      data: {
        workspaceId: input.workspaceId,
        creditAccountId: account.id,
        reservationId: reservation.id,
        creditLotId: lotAllocation.creditLotId,
        type: "HOLD",
        bucket: "PURCHASED",
        amount: lotAllocation.amount,
        availableDelta: -lotAllocation.amount,
        heldDelta: lotAllocation.amount,
        balanceAfterAvailable: account.purchasedAvailable,
        balanceAfterHeld: account.purchasedHeld,
        idempotencyKey: `reservation:${reservation.id}:hold:purchased:${lotAllocation.creditLotId}`,
        occurredAt: now,
        metadata: { expiresAt: lotAllocation.expiresAt.toISOString(), operation: quote.operation, pricingVersion: quote.pricingVersion },
      },
    });
  }
  return { reservation, replayed: false };
}

async function lockedReservation(
  tx: Prisma.TransactionClient,
  input: { workspaceId: string; reservationId: string },
): Promise<{ account: CreditAccount; reservation: CreditReservation }> {
  const initial = await tx.creditReservation.findUnique({ where: { id: input.reservationId } });
  if (!initial || initial.workspaceId !== input.workspaceId) throw new AppError("not_found", "Credit reservation not found");
  const account = await lockAccount(tx, input.workspaceId);
  await tx.$queryRaw(Prisma.sql`
    SELECT "id" FROM "credit_reservations"
    WHERE "id" = ${input.reservationId}::uuid
    FOR UPDATE
  `);
  const reservation = await tx.creditReservation.findUniqueOrThrow({ where: { id: input.reservationId } });
  return { account, reservation };
}

async function lockReservationLots(
  tx: Prisma.TransactionClient,
  reservation: CreditReservation,
): Promise<LotAllocationWithLot[]> {
  if (reservation.purchasedCredits === 0n) return [];
  await tx.$queryRaw(Prisma.sql`
    SELECT lots."id" FROM "credit_lots" lots
    INNER JOIN "credit_reservation_lot_allocations" allocations
      ON allocations."creditLotId" = lots."id"
    WHERE allocations."reservationId" = ${reservation.id}::uuid
    ORDER BY lots."expiresAt", lots."id"
    FOR UPDATE OF lots
  `);
  const allocations = await tx.creditReservationLotAllocation.findMany({
    where: { reservationId: reservation.id },
    include: { creditLot: true },
  });
  const allocated = allocations.reduce((total, allocation) => total + allocation.amount, 0n);
  if (allocated !== reservation.purchasedCredits) {
    throw new AppError("internal_error", "Purchased credit reservation allocations are inconsistent");
  }
  return allocations;
}

function assertHeldBalances(
  account: CreditAccount,
  reservation: CreditReservation,
  lotAllocations: LotAllocationWithLot[],
): void {
  if (
    account.includedHeld < reservation.includedCredits
    || account.promotionalHeld < reservation.promotionalCredits
    || account.purchasedHeld < reservation.purchasedCredits
    || lotAllocations.some((allocation) => allocation.creditLot.heldCredits < allocation.amount)
  ) {
    throw new AppError("internal_error", "Credit reservation held balances are inconsistent");
  }
}

export async function settleCreditReservation(
  tx: Prisma.TransactionClient,
  input: { workspaceId: string; reservationId: string; now?: Date },
): Promise<{ reservation: CreditReservation; replayed: boolean }> {
  const now = input.now ?? new Date();
  let { account, reservation } = await lockedReservation(tx, input);
  if (reservation.status === "SETTLED") return { reservation, replayed: true };
  if (reservation.status !== "HELD") throw new AppError("conflict", "Released credits cannot be settled");
  const lotAllocations = await lockReservationLots(tx, reservation);
  assertHeldBalances(account, reservation, lotAllocations);

  if (reservation.quotedCredits > 0n) {
    account = await tx.creditAccount.update({
      where: { id: account.id },
      data: {
        includedHeld: { decrement: reservation.includedCredits },
        promotionalHeld: { decrement: reservation.promotionalCredits },
        purchasedHeld: { decrement: reservation.purchasedCredits },
        optimisticVersion: { increment: 1 },
      },
    });
  }
  for (const allocation of lotAllocations) {
    await tx.creditLot.update({ where: { id: allocation.creditLotId }, data: { heldCredits: { decrement: allocation.amount } } });
  }
  for (const [bucket, amount] of [
    ["INCLUDED", reservation.includedCredits],
    ["PROMOTIONAL", reservation.promotionalCredits],
  ] as const) {
    if (amount === 0n) continue;
    const balances = bucketBalances(account, bucket);
    await tx.creditLedger.create({
      data: {
        workspaceId: input.workspaceId,
        creditAccountId: account.id,
        reservationId: reservation.id,
        subscriptionPeriodId: bucket === "INCLUDED" ? reservation.includedSourcePeriodId : null,
        type: "SETTLEMENT",
        bucket,
        amount,
        availableDelta: 0n,
        heldDelta: -amount,
        balanceAfterAvailable: balances.available,
        balanceAfterHeld: balances.held,
        idempotencyKey: `reservation:${reservation.id}:settle:${bucket.toLowerCase()}`,
        occurredAt: now,
      },
    });
  }
  for (const allocation of lotAllocations) {
    await tx.creditLedger.create({
      data: {
        workspaceId: input.workspaceId,
        creditAccountId: account.id,
        reservationId: reservation.id,
        creditLotId: allocation.creditLotId,
        type: "SETTLEMENT",
        bucket: "PURCHASED",
        amount: allocation.amount,
        availableDelta: 0n,
        heldDelta: -allocation.amount,
        balanceAfterAvailable: account.purchasedAvailable,
        balanceAfterHeld: account.purchasedHeld,
        idempotencyKey: `reservation:${reservation.id}:settle:purchased:${allocation.creditLotId}`,
        occurredAt: now,
      },
    });
  }
  reservation = await tx.creditReservation.update({
    where: { id: reservation.id },
    data: { status: "SETTLED", settledAt: now },
  });
  return { reservation, replayed: false };
}

export async function releaseCreditReservation(
  tx: Prisma.TransactionClient,
  input: { workspaceId: string; reservationId: string; now?: Date },
): Promise<{ reservation: CreditReservation; replayed: boolean; expiredIncluded: bigint; expiredPurchased: bigint }> {
  const now = input.now ?? new Date();
  await expireStaleIncludedCredits(tx, { workspaceId: input.workspaceId, now });
  await expireStalePurchasedCredits(tx, { workspaceId: input.workspaceId, now });
  let { account, reservation } = await lockedReservation(tx, input);
  if (reservation.status === "RELEASED") {
    return { reservation, replayed: true, expiredIncluded: 0n, expiredPurchased: 0n };
  }
  if (reservation.status !== "HELD") throw new AppError("conflict", "Settled credits cannot be released");
  const lotAllocations = await lockReservationLots(tx, reservation);
  assertHeldBalances(account, reservation, lotAllocations);

  let restoreIncluded = false;
  if (reservation.includedCredits > 0n && reservation.includedSourcePeriodId) {
    const period = await tx.billingSubscriptionPeriod.findUnique({ where: { id: reservation.includedSourcePeriodId } });
    restoreIncluded = Boolean(
      period
      && period.workspaceId === input.workspaceId
      && period.periodEnd.getTime() > now.getTime()
      && (account.includedSourcePeriodId === null || account.includedSourcePeriodId === period.id),
    );
  }
  const restoredIncluded = restoreIncluded ? reservation.includedCredits : 0n;
  const expiredIncluded = reservation.includedCredits - restoredIncluded;
  const restoredPurchased = lotAllocations.reduce(
    (total, allocation) => total + (allocation.creditLot.expiresAt.getTime() > now.getTime() ? allocation.amount : 0n),
    0n,
  );
  const expiredPurchased = reservation.purchasedCredits - restoredPurchased;

  if (reservation.quotedCredits > 0n) {
    account = await tx.creditAccount.update({
      where: { id: account.id },
      data: {
        includedAvailable: { increment: restoredIncluded },
        includedHeld: { decrement: reservation.includedCredits },
        ...(restoredIncluded > 0n && account.includedSourcePeriodId === null
          ? { includedSourcePeriodId: reservation.includedSourcePeriodId }
          : {}),
        promotionalAvailable: { increment: reservation.promotionalCredits },
        promotionalHeld: { decrement: reservation.promotionalCredits },
        purchasedAvailable: { increment: restoredPurchased },
        purchasedHeld: { decrement: reservation.purchasedCredits },
        optimisticVersion: { increment: 1 },
      },
    });
  }
  for (const allocation of lotAllocations) {
    const restore = allocation.creditLot.expiresAt.getTime() > now.getTime();
    await tx.creditLot.update({
      where: { id: allocation.creditLotId },
      data: {
        availableCredits: { increment: restore ? allocation.amount : 0n },
        heldCredits: { decrement: allocation.amount },
        ...(!restore && allocation.creditLot.expiredAt === null ? { expiredAt: now } : {}),
      },
    });
  }

  for (const [bucket, amount] of [
    ["INCLUDED", reservation.includedCredits],
    ["PROMOTIONAL", reservation.promotionalCredits],
  ] as const) {
    if (amount === 0n) continue;
    const balances = bucketBalances(account, bucket);
    const includedExpired = bucket === "INCLUDED" && !restoreIncluded;
    await tx.creditLedger.create({
      data: {
        workspaceId: input.workspaceId,
        creditAccountId: account.id,
        reservationId: reservation.id,
        subscriptionPeriodId: bucket === "INCLUDED" ? reservation.includedSourcePeriodId : null,
        type: includedExpired ? "PERIOD_EXPIRY" : "RELEASE",
        bucket,
        amount,
        availableDelta: includedExpired ? 0n : amount,
        heldDelta: -amount,
        balanceAfterAvailable: balances.available,
        balanceAfterHeld: balances.held,
        idempotencyKey: `reservation:${reservation.id}:release:${bucket.toLowerCase()}`,
        occurredAt: now,
      },
    });
  }
  for (const allocation of lotAllocations) {
    const restore = allocation.creditLot.expiresAt.getTime() > now.getTime();
    await tx.creditLedger.create({
      data: {
        workspaceId: input.workspaceId,
        creditAccountId: account.id,
        reservationId: reservation.id,
        creditLotId: allocation.creditLotId,
        type: restore ? "RELEASE" : "PURCHASE_EXPIRY",
        bucket: "PURCHASED",
        amount: allocation.amount,
        availableDelta: restore ? allocation.amount : 0n,
        heldDelta: -allocation.amount,
        balanceAfterAvailable: account.purchasedAvailable,
        balanceAfterHeld: account.purchasedHeld,
        idempotencyKey: `reservation:${reservation.id}:release:purchased:${allocation.creditLotId}`,
        occurredAt: now,
      },
    });
  }
  reservation = await tx.creditReservation.update({
    where: { id: reservation.id },
    data: { status: "RELEASED", releasedAt: now },
  });
  return { reservation, replayed: false, expiredIncluded, expiredPurchased };
}
