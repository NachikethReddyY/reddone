import type { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import {
  isPrismaWriteConflict,
  withSerializableTransaction,
  type SerializableTransactionHost,
} from "@/server/transactions";

describe("serializable transaction retries", () => {
  it("retries P2034 conflicts within the configured bound", async () => {
    const conflict = Object.assign(new Error("write conflict"), { code: "P2034" });
    const transaction = vi.fn();
    let attempts = 0;
    const db: SerializableTransactionHost = {
      async $transaction<T>(
        operation: (tx: Prisma.TransactionClient) => Promise<T>,
        options: { isolationLevel: "Serializable"; timeout: number },
      ): Promise<T> {
        transaction(operation, options);
        attempts += 1;
        if (attempts < 3) throw conflict;
        return operation({} as Prisma.TransactionClient);
      },
    };

    await expect(
      withSerializableTransaction(db, async () => "committed", { maxAttempts: 3, retryDelayMs: 0 }),
    ).resolves.toBe("committed");
    expect(transaction).toHaveBeenCalledTimes(3);
    expect(transaction).toHaveBeenLastCalledWith(expect.any(Function), {
      isolationLevel: "Serializable",
      timeout: 20_000,
    });
  });

  it("does not retry other failures or exceed the maximum", async () => {
    const failure = new Error("validation failed");
    const transaction = vi.fn();
    const db: SerializableTransactionHost = {
      async $transaction<T>(
        operation: (tx: Prisma.TransactionClient) => Promise<T>,
        options: { isolationLevel: "Serializable"; timeout: number },
      ): Promise<T> {
        transaction(operation, options);
        throw failure;
      },
    };
    await expect(withSerializableTransaction(db, async () => undefined, { retryDelayMs: 0 })).rejects.toBe(failure);
    expect(transaction).toHaveBeenCalledOnce();
    expect(isPrismaWriteConflict(Object.assign(new Error(), { code: "P2034" }))).toBe(true);
    await expect(withSerializableTransaction(db, async () => undefined, { maxAttempts: 6 })).rejects.toThrow(/maxAttempts/);
  });
});
