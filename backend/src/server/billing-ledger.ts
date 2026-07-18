import "server-only";

import { Prisma, type CreditLedger } from "@prisma/client";
import { z } from "zod";

import {
  BillingLedgerPageSchema,
  type BillingLedgerEntry,
  type BillingLedgerPage,
  type BillingLedgerQuery,
} from "@/contracts";
import { IdSchema, IsoDateTimeSchema } from "@/contracts/common";
import { tryGetDb } from "./db";
import { AppError } from "./errors";

const BillingLedgerCursorSchema = z
  .object({
    occurredAt: IsoDateTimeSchema,
    id: IdSchema,
  })
  .strict();

const persistedWorkspacePattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type BillingLedgerDatabase = NonNullable<ReturnType<typeof tryGetDb>>;

type LedgerCursor = z.infer<typeof BillingLedgerCursorSchema>;

export function billingLedgerDescription(type: string): string {
  const descriptions: Record<string, string> = {
    PROMOTIONAL_GRANT: "Promotional credits granted",
    PERIOD_GRANT: "Monthly included credits granted",
    PERIOD_EXPIRY: "Monthly included credits expired",
    PURCHASE: "Pay-as-you-go credits purchased",
    HOLD: "Credits reserved for a workflow",
    SETTLEMENT: "Workflow credit charge settled",
    RELEASE: "Reserved credits released",
    ADJUSTMENT: "Support credit adjustment",
  };
  return descriptions[type] ?? "Credit balance updated";
}

export function encodeBillingLedgerCursor(cursor: LedgerCursor): string {
  const parsed = BillingLedgerCursorSchema.parse(cursor);
  return Buffer.from(JSON.stringify(parsed), "utf8").toString("base64url");
}

export function decodeBillingLedgerCursor(cursor: string): LedgerCursor {
  try {
    const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
    return BillingLedgerCursorSchema.parse(decoded);
  } catch (error) {
    throw new AppError("bad_request", "The billing ledger cursor is invalid.", { cause: error });
  }
}

export function serializeBillingLedgerEntry(entry: Pick<
  CreditLedger,
  "id" | "type" | "amount" | "availableDelta" | "heldDelta" | "bucket" | "occurredAt"
>): BillingLedgerEntry {
  return {
    id: entry.id,
    type: entry.type.toLowerCase(),
    amount: String(entry.availableDelta !== 0n ? entry.availableDelta : entry.heldDelta),
    availableDelta: String(entry.availableDelta),
    heldDelta: String(entry.heldDelta),
    bucket: entry.bucket.toLowerCase(),
    description: billingLedgerDescription(entry.type),
    occurredAt: entry.occurredAt.toISOString(),
  };
}

export async function getBillingLedgerPage(
  workspaceId: string,
  query: BillingLedgerQuery,
  database?: BillingLedgerDatabase | null,
): Promise<BillingLedgerPage> {
  const cursor = query.cursor ? decodeBillingLedgerCursor(query.cursor) : null;
  const db = database === undefined
    ? persistedWorkspacePattern.test(workspaceId) ? tryGetDb() : null
    : database;
  if (!db) return BillingLedgerPageSchema.parse({ items: [], nextCursor: null });
  const where: Prisma.CreditLedgerWhereInput = {
    workspaceId,
    ...(cursor
      ? {
          OR: [
            { occurredAt: { lt: new Date(cursor.occurredAt) } },
            { occurredAt: new Date(cursor.occurredAt), id: { lt: cursor.id } },
          ],
        }
      : {}),
  };
  const rows = await db.creditLedger.findMany({
    where,
    orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
    take: query.limit + 1,
  });
  const pageRows = rows.slice(0, query.limit);
  const last = pageRows.at(-1);

  return BillingLedgerPageSchema.parse({
    items: pageRows.map(serializeBillingLedgerEntry),
    nextCursor: rows.length > query.limit && last
      ? encodeBillingLedgerCursor({ occurredAt: last.occurredAt.toISOString(), id: last.id })
      : null,
  });
}
