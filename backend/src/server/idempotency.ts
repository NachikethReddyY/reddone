import { createHash } from "node:crypto";

import { z } from "zod";

import { canonicalJson } from "./security/canonical-json";
import { AppError } from "./errors";

export const IdempotencyKeySchema = z
  .string()
  .trim()
  .min(8)
  .max(200)
  .regex(/^[A-Za-z0-9._:-]+$/, "Idempotency keys may only contain URL-safe visible characters");

export function normalizeIdempotencyKey(value: string): string {
  return IdempotencyKeySchema.parse(value);
}

export function deriveIdempotencyKey(namespace: string, parts: readonly unknown[]): string {
  const normalizedNamespace = z.string().trim().min(1).max(80).regex(/^[a-z0-9._:-]+$/i).parse(namespace);
  const digest = createHash("sha256").update(canonicalJson(parts), "utf8").digest("hex");
  return `${normalizedNamespace}:${digest}`;
}

export function requestFingerprint(method: string, pathname: string, body: unknown): string {
  return createHash("sha256")
    .update(
      canonicalJson({
        method: method.trim().toUpperCase(),
        pathname,
        body,
      }),
      "utf8",
    )
    .digest("hex");
}

interface PendingRecord<T> {
  fingerprint: string;
  promise: Promise<T>;
}

interface CompletedRecord<T> {
  fingerprint: string;
  value: T;
  expiresAt: number;
}

export interface IdempotentResult<T> {
  value: T;
  replayed: boolean;
}

/**
 * A process-local implementation for demo mode and tests. Production uses the
 * database uniqueness constraints and inbox/outbox records from the Prisma schema.
 */
export class InMemoryIdempotencyStore {
  readonly #pending = new Map<string, PendingRecord<unknown>>();
  readonly #completed = new Map<string, CompletedRecord<unknown>>();

  constructor(private readonly ttlMs = 24 * 60 * 60_000) {}

  async execute<T>(
    keyInput: string,
    fingerprint: string,
    operation: () => Promise<T> | T,
  ): Promise<IdempotentResult<T>> {
    const key = normalizeIdempotencyKey(keyInput);
    const now = Date.now();
    this.#removeExpired(now);

    const completed = this.#completed.get(key);
    if (completed) {
      this.#assertFingerprint(completed.fingerprint, fingerprint);
      return { value: completed.value as T, replayed: true };
    }

    const pending = this.#pending.get(key);
    if (pending) {
      this.#assertFingerprint(pending.fingerprint, fingerprint);
      return { value: (await pending.promise) as T, replayed: true };
    }

    const promise = Promise.resolve().then(operation);
    this.#pending.set(key, { fingerprint, promise });
    try {
      const value = await promise;
      this.#completed.set(key, { fingerprint, value, expiresAt: now + this.ttlMs });
      return { value, replayed: false };
    } finally {
      this.#pending.delete(key);
    }
  }

  clear(): void {
    this.#pending.clear();
    this.#completed.clear();
  }

  #assertFingerprint(existing: string, incoming: string): void {
    if (existing !== incoming) {
      throw new AppError("conflict", "The idempotency key was already used for a different request");
    }
  }

  #removeExpired(now: number): void {
    for (const [key, record] of this.#completed) {
      if (record.expiresAt <= now) this.#completed.delete(key);
    }
  }
}
