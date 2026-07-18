import "server-only";

import type { Prisma } from "@prisma/client";

const DEFAULT_MAX_ATTEMPTS = 3;
const MAX_ATTEMPTS = 5;

export interface SerializableTransactionHost {
  $transaction<T>(
    operation: (tx: Prisma.TransactionClient) => Promise<T>,
    options: { isolationLevel: "Serializable"; timeout: number },
  ): Promise<T>;
}

export interface SerializableRetryOptions {
  maxAttempts?: number;
  timeoutMs?: number;
  retryDelayMs?: number;
}

export function isPrismaWriteConflict(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "P2034";
}

function delay(milliseconds: number): Promise<void> {
  return milliseconds > 0 ? new Promise((resolve) => setTimeout(resolve, milliseconds)) : Promise.resolve();
}

/** Retries only Prisma write conflicts and always caps the number of transactions. */
export async function withSerializableTransaction<T>(
  db: SerializableTransactionHost,
  operation: (tx: Prisma.TransactionClient) => Promise<T>,
  options: SerializableRetryOptions = {},
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > MAX_ATTEMPTS) {
    throw new RangeError(`maxAttempts must be between 1 and ${MAX_ATTEMPTS}.`);
  }
  const timeout = options.timeoutMs ?? 20_000;
  const retryDelayMs = options.retryDelayMs ?? 20;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await db.$transaction(operation, { isolationLevel: "Serializable", timeout });
    } catch (error) {
      if (!isPrismaWriteConflict(error) || attempt === maxAttempts) throw error;
      await delay(Math.min(retryDelayMs * 2 ** (attempt - 1), 250));
    }
  }

  throw new Error("Serializable transaction retry loop exhausted unexpectedly.");
}
