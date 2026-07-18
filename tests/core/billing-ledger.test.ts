import { describe, expect, it, vi } from "vitest";

import { BillingLedgerPageSchema, BillingLedgerQuerySchema } from "@/contracts";
import {
  decodeBillingLedgerCursor,
  encodeBillingLedgerCursor,
  getBillingLedgerPage,
} from "@/server/billing-ledger";

const workspaceId = "019f4f17-1fc3-7fa1-9eaa-624e8f87b2bf";

function ledgerRow(id: string, occurredAt: string, availableDelta: bigint, heldDelta = 0n) {
  return {
    id,
    workspaceId,
    creditAccountId: "019f4f17-1fc3-7fa1-9eaa-624e8f87b2aa",
    reservationId: null,
    subscriptionPeriodId: null,
    checkoutSessionId: null,
    creditLotId: null,
    creditCodeRedemptionId: null,
    stripeEventId: null,
    type: availableDelta < 0n ? "SETTLEMENT" : "PURCHASE",
    bucket: "PURCHASED",
    amount: availableDelta,
    availableDelta,
    heldDelta,
    balanceAfterAvailable: 0n,
    balanceAfterHeld: 0n,
    idempotencyKey: `ledger-${id}`,
    externalReference: null,
    metadata: {},
    occurredAt: new Date(occurredAt),
    createdAt: new Date(occurredAt),
  };
}

describe("billing ledger pagination", () => {
  it("uses a stable occurredAt/id cursor and requests one extra row", async () => {
    const rows = [
      ledgerRow("019f4f17-1fc3-7fa1-9eaa-624e8f87b301", "2026-07-17T12:00:00.000Z", 100n),
      ledgerRow("019f4f17-1fc3-7fa1-9eaa-624e8f87b300", "2026-07-17T12:00:00.000Z", -20n),
      ledgerRow("019f4f17-1fc3-7fa1-9eaa-624e8f87b2ff", "2026-07-16T12:00:00.000Z", 300n),
    ];
    const findMany = vi.fn(async () => rows);
    const query = BillingLedgerQuerySchema.parse({ limit: 2 });

    const page = await getBillingLedgerPage(workspaceId, query, { creditLedger: { findMany } } as never);

    expect(BillingLedgerPageSchema.parse(page)).toEqual(page);
    expect(page.items).toHaveLength(2);
    expect(page.items[1]).toMatchObject({
      id: rows[1]!.id,
      amount: "-20",
      availableDelta: "-20",
      heldDelta: "0",
      description: "Workflow credit charge settled",
    });
    expect(page.nextCursor).not.toBeNull();
    expect(decodeBillingLedgerCursor(page.nextCursor!)).toEqual({
      occurredAt: rows[1]!.occurredAt.toISOString(),
      id: rows[1]!.id,
    });
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
      orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
      take: 3,
      where: { workspaceId },
    }));
  });

  it("applies the cursor strictly below the last returned timestamp and id", async () => {
    const cursor = encodeBillingLedgerCursor({
      occurredAt: "2026-07-17T12:00:00.000Z",
      id: "019f4f17-1fc3-7fa1-9eaa-624e8f87b300",
    });
    const findMany = vi.fn(async () => []);

    const page = await getBillingLedgerPage(
      workspaceId,
      BillingLedgerQuerySchema.parse({ cursor, limit: 25 }),
      { creditLedger: { findMany } } as never,
    );

    expect(page).toEqual({ items: [], nextCursor: null });
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
      take: 26,
      where: {
        workspaceId,
        OR: [
          { occurredAt: { lt: new Date("2026-07-17T12:00:00.000Z") } },
          {
            occurredAt: new Date("2026-07-17T12:00:00.000Z"),
            id: { lt: "019f4f17-1fc3-7fa1-9eaa-624e8f87b300" },
          },
        ],
      },
    }));
  });

  it("rejects malformed cursors and unknown query fields", () => {
    expect(() => decodeBillingLedgerCursor("not-a-cursor")).toThrow("The billing ledger cursor is invalid.");
    expect(() => BillingLedgerQuerySchema.parse({ limit: 25, workspaceId })).toThrow();
  });
});
