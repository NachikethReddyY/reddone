import "server-only";

import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import type { Prisma } from "@prisma/client";
import { z } from "zod";

import { getDb } from "./db";
import { getRuntimeConfig } from "./env";
import { canonicalJson } from "./security/canonical-json";

const RECEIPT_EVENT_TYPE = "api.idempotency.receipt";
const RECEIPT_AGGREGATE_TYPE = "api_idempotency";

const PersistedErrorSchema = z
  .object({
    code: z.string().trim().min(1).max(100),
    message: z.string().trim().min(1).max(500),
    status: z.number().int().min(400).max(599),
    retryable: z.boolean(),
  })
  .strict();

const ReceiptPayloadSchema = z.discriminatedUnion("state", [
  z
    .object({
      schemaVersion: z.literal(1),
      operation: z.string().trim().min(1).max(150),
      requestFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
      state: z.literal("pending"),
    })
    .strict(),
  z
    .object({
      schemaVersion: z.literal(1),
      operation: z.string().trim().min(1).max(150),
      requestFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
      state: z.literal("completed"),
      response: z.unknown(),
    })
    .strict(),
  z
    .object({
      schemaVersion: z.literal(1),
      operation: z.string().trim().min(1).max(150),
      requestFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
      state: z.literal("failed"),
      error: PersistedErrorSchema,
    })
    .strict(),
]);

export type PersistedIdempotencyError = z.infer<typeof PersistedErrorSchema>;
export type PublishedIdempotencyOutcome =
  | { ok: true; response: unknown }
  | { ok: false; error: PersistedIdempotencyError };

type ReceiptEvent = {
  id: string;
  eventType: string;
  aggregateVersion: number;
  payload: unknown;
  payloadHash: string;
  availableAt: Date;
};

export type PublishedIdempotencyClaim = {
  receiptId: string;
  fencingVersion: number;
};

export type PublishedIdempotencyClaimResult =
  | { kind: "execute"; claim: PublishedIdempotencyClaim }
  | { kind: "replay"; outcome: PublishedIdempotencyOutcome }
  | { kind: "in_progress" };

function payloadHash(payload: unknown) {
  return createHash("sha256").update(canonicalJson(payload)).digest("hex");
}

function receiptAggregateId(idempotencyKey: string) {
  return createHash("sha256").update(idempotencyKey).digest("hex");
}

function fingerprintsEqual(left: string, right: string) {
  if (!/^[a-f0-9]{64}$/.test(left) || !/^[a-f0-9]{64}$/.test(right)) return false;
  const leftBytes = Buffer.from(left, "hex");
  const rightBytes = Buffer.from(right, "hex");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function receiptPayload(
  operation: string,
  requestFingerprint: string,
  outcome?: PublishedIdempotencyOutcome,
) {
  if (!outcome) return ReceiptPayloadSchema.parse({ schemaVersion: 1, operation, requestFingerprint, state: "pending" });
  return outcome.ok
    ? ReceiptPayloadSchema.parse({ schemaVersion: 1, operation, requestFingerprint, state: "completed", response: outcome.response })
    : ReceiptPayloadSchema.parse({ schemaVersion: 1, operation, requestFingerprint, state: "failed", error: outcome.error });
}

/** HMACs canonical request material so a persisted fingerprint cannot be used to guess secret-bearing input. */
export function secureIdempotencyFingerprint(operation: string, request: unknown, signingKey?: string) {
  const key = signingKey ?? getRuntimeConfig().auth.secret;
  if (!key) throw new Error("A server signing key is required for production idempotency.");
  return createHmac("sha256", key)
    .update(canonicalJson({ operation, request }))
    .digest("hex");
}

export function parsePublishedIdempotencyReceipt(
  event: Pick<ReceiptEvent, "eventType" | "payload" | "payloadHash">,
  expected: { operation: string; requestFingerprint: string },
) {
  if (event.eventType !== RECEIPT_EVENT_TYPE) {
    throw new Error("The idempotency key was already used for a different mutation.");
  }
  const payload = ReceiptPayloadSchema.parse(event.payload);
  if (!fingerprintsEqual(event.payloadHash, payloadHash(payload))) {
    throw new Error("Stored idempotency receipt integrity check failed.");
  }
  if (payload.operation !== expected.operation || !fingerprintsEqual(payload.requestFingerprint, expected.requestFingerprint)) {
    throw new Error("The idempotency key was already used for different request input.");
  }
  if (payload.state === "completed") return { state: payload.state, outcome: { ok: true as const, response: payload.response } };
  if (payload.state === "failed") return { state: payload.state, outcome: { ok: false as const, error: payload.error } };
  return { state: payload.state, outcome: null };
}

export async function readPublishedIdempotencyReceipt(input: {
  workspaceId: string;
  idempotencyKey: string;
  operation: string;
  requestFingerprint: string;
}) {
  const event = await getDb().outboxEvent.findUnique({
    where: { workspaceId_idempotencyKey: { workspaceId: input.workspaceId, idempotencyKey: input.idempotencyKey } },
    select: { eventType: true, payload: true, payloadHash: true },
  });
  if (!event) return null;
  return parsePublishedIdempotencyReceipt(event, input);
}

export function completedPublishedIdempotencyReceiptData(input: {
  workspaceId: string;
  idempotencyKey: string;
  operation: string;
  requestFingerprint: string;
  outcome: PublishedIdempotencyOutcome;
}) {
  const payload = receiptPayload(input.operation, input.requestFingerprint, input.outcome);
  return {
    workspaceId: input.workspaceId,
    aggregateType: RECEIPT_AGGREGATE_TYPE,
    aggregateId: receiptAggregateId(input.idempotencyKey),
    aggregateVersion: 1,
    eventType: RECEIPT_EVENT_TYPE,
    payload: payload as Prisma.InputJsonValue,
    payloadHash: payloadHash(payload),
    idempotencyKey: input.idempotencyKey,
    publishedAt: new Date(),
  };
}

async function interpretClaimEvent(
  event: ReceiptEvent,
  input: { workspaceId: string; operation: string; requestFingerprint: string },
  leaseMs: number,
): Promise<PublishedIdempotencyClaimResult> {
  const parsed = parsePublishedIdempotencyReceipt(event, input);
  if (parsed.outcome) return { kind: "replay", outcome: parsed.outcome };
  const now = new Date();
  if (event.availableAt > now) return { kind: "in_progress" };

  const availableAt = new Date(now.getTime() + leaseMs);
  const pending = receiptPayload(input.operation, input.requestFingerprint);
  const claimed = await getDb().outboxEvent.updateMany({
    where: {
      id: event.id,
      workspaceId: input.workspaceId,
      aggregateVersion: event.aggregateVersion,
      availableAt: { lte: now },
    },
    data: {
      aggregateVersion: { increment: 1 },
      payload: pending as Prisma.InputJsonValue,
      payloadHash: payloadHash(pending),
      availableAt,
      attemptCount: { increment: 1 },
      lastError: null,
    },
  });
  if (claimed.count === 1) return { kind: "execute", claim: { receiptId: event.id, fencingVersion: event.aggregateVersion + 1 } };
  return { kind: "in_progress" };
}

/** Claims a published outbox row before an external call, preventing concurrent duplicate provider work. */
export async function claimPublishedIdempotencyReceipt(input: {
  workspaceId: string;
  idempotencyKey: string;
  operation: string;
  requestFingerprint: string;
  leaseMs?: number;
}): Promise<PublishedIdempotencyClaimResult> {
  const db = getDb();
  const leaseMs = Math.min(Math.max(input.leaseMs ?? 120_000, 30_000), 10 * 60_000);
  const existing = await db.outboxEvent.findUnique({
    where: { workspaceId_idempotencyKey: { workspaceId: input.workspaceId, idempotencyKey: input.idempotencyKey } },
    select: { id: true, eventType: true, aggregateVersion: true, payload: true, payloadHash: true, availableAt: true },
  });
  if (existing) return interpretClaimEvent(existing, input, leaseMs);

  const availableAt = new Date(Date.now() + leaseMs);
  const pending = receiptPayload(input.operation, input.requestFingerprint);
  try {
    const created = await db.outboxEvent.create({
      data: {
        workspaceId: input.workspaceId,
        aggregateType: RECEIPT_AGGREGATE_TYPE,
        aggregateId: receiptAggregateId(input.idempotencyKey),
        aggregateVersion: 1,
        eventType: RECEIPT_EVENT_TYPE,
        payload: pending as Prisma.InputJsonValue,
        payloadHash: payloadHash(pending),
        idempotencyKey: input.idempotencyKey,
        availableAt,
        publishedAt: new Date(),
      },
      select: { id: true, aggregateVersion: true },
    });
    return { kind: "execute", claim: { receiptId: created.id, fencingVersion: created.aggregateVersion } };
  } catch (error) {
    const raced = await db.outboxEvent.findUnique({
      where: { workspaceId_idempotencyKey: { workspaceId: input.workspaceId, idempotencyKey: input.idempotencyKey } },
      select: { id: true, eventType: true, aggregateVersion: true, payload: true, payloadHash: true, availableAt: true },
    });
    if (!raced) throw error;
    return interpretClaimEvent(raced, input, leaseMs);
  }
}

export async function completePublishedIdempotencyReceipt(input: {
  workspaceId: string;
  claim: PublishedIdempotencyClaim;
  operation: string;
  requestFingerprint: string;
  outcome: PublishedIdempotencyOutcome;
  audit?: {
    actorUserId?: string;
    action: string;
    targetType: string;
    targetId: string;
    requestId?: string;
    metadata: Prisma.InputJsonValue;
  };
}) {
  await getDb().$transaction((tx) => completePublishedIdempotencyReceiptInTransaction(tx, input));
}

export async function completePublishedIdempotencyReceiptInTransaction(
  tx: Prisma.TransactionClient,
  input: {
    workspaceId: string;
    claim: PublishedIdempotencyClaim;
    operation: string;
    requestFingerprint: string;
    outcome: PublishedIdempotencyOutcome;
    audit?: {
      actorUserId?: string;
      action: string;
      targetType: string;
      targetId: string;
      requestId?: string;
      metadata: Prisma.InputJsonValue;
    };
  },
) {
  const payload = receiptPayload(input.operation, input.requestFingerprint, input.outcome);
  const updated = await tx.outboxEvent.updateMany({
      where: {
        id: input.claim.receiptId,
        workspaceId: input.workspaceId,
        aggregateVersion: input.claim.fencingVersion,
        eventType: RECEIPT_EVENT_TYPE,
      },
      data: {
        payload: payload as Prisma.InputJsonValue,
        payloadHash: payloadHash(payload),
        availableAt: new Date(),
        publishedAt: new Date(),
        lastError: input.outcome.ok ? null : input.outcome.error.message,
      },
    });
  if (updated.count !== 1) throw new Error("The idempotency receipt claim expired before completion.");
  if (input.audit) {
    await tx.auditEvent.create({
        data: {
          workspaceId: input.workspaceId,
          actorUserId: input.audit.actorUserId ?? null,
          action: input.audit.action,
          targetType: input.audit.targetType,
          targetId: input.audit.targetId,
          requestId: input.audit.requestId ?? null,
          metadata: input.audit.metadata,
          expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60_000),
        },
      });
  }
}
