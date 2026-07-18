import "server-only";

import type { Prisma } from "@prisma/client";

function currentUtcMonthStart(now: Date) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/**
 * Reserves against both metered spend in the current UTC month and the unused
 * portion of every active reservation. Call from a serializable transaction.
 */
export async function assertWorkspaceBudgetAvailable(
  tx: Prisma.TransactionClient,
  input: { workspaceId: string; monthlyBudgetMicros: bigint; requestedMicros: bigint; now?: Date },
) {
  if (input.requestedMicros < 1n) throw new Error("A positive budget reservation is required.");
  if (input.monthlyBudgetMicros === 0n) return;
  const now = input.now ?? new Date();
  const monthStart = currentUtcMonthStart(now);
  const reservations = await tx.budgetReservation.findMany({
    where: {
      workspaceId: input.workspaceId,
      OR: [
        { createdAt: { gte: monthStart, lte: now } },
        { status: { in: ["RESERVED", "EXCEEDED"] } },
      ],
    },
    select: { reservedMicros: true, actualMicros: true, status: true, createdAt: true },
  });
  const meteredSpend = reservations.reduce(
    (total, reservation) => total + (reservation.createdAt >= monthStart && reservation.createdAt <= now ? reservation.actualMicros ?? 0n : 0n),
    0n,
  );
  const unusedReservations = reservations.reduce((total, reservation) => {
    if (reservation.status !== "RESERVED" && reservation.status !== "EXCEEDED") return total;
    const remaining = reservation.reservedMicros - (reservation.actualMicros ?? 0n);
    return total + (remaining > 0n ? remaining : 0n);
  }, 0n);
  const committedMicros = meteredSpend + unusedReservations;
  if (committedMicros + input.requestedMicros > input.monthlyBudgetMicros) {
    throw new Error("The workspace monthly budget cannot reserve this operation.");
  }
}
