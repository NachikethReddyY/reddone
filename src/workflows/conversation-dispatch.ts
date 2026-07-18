import "server-only";

import { createHash } from "node:crypto";

import { start } from "workflow/api";

import { getDb } from "@/server/db";
import { canonicalJson } from "@/server/security/canonical-json";

import { executeConversationTurn } from "./conversation-agent";

function validPayload(payload: unknown, expected: { workspaceId: string; turnId: string }) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  const record = payload as Record<string, unknown>;
  return record.schemaVersion === 1
    && record.workspaceId === expected.workspaceId
    && record.turnId === expected.turnId
    && typeof record.projectId === "string"
    && typeof record.conversationId === "string";
}

export async function dispatchConversationTurn(workspaceId: string, turnId: string) {
  const db = getDb();
  const event = await db.outboxEvent.findFirst({
    where: { workspaceId, aggregateType: "conversation_turn", aggregateId: turnId, eventType: "conversation.turn.queued" },
    orderBy: { createdAt: "desc" },
  });
  if (!event) throw new Error("Conversation outbox event not found.");
  if (event.publishedAt) {
    const payload = event.payload as Record<string, unknown>;
    return typeof payload.executorRunId === "string" ? payload.executorRunId : null;
  }
  const turn = await db.conversationTurn.findFirst({ where: { id: turnId, workspaceId }, select: { status: true } });
  let hash = "invalid";
  try { hash = createHash("sha256").update(canonicalJson(event.payload)).digest("hex"); } catch { /* dead-letter safely below */ }
  if (!turn || hash !== event.payloadHash || !validPayload(event.payload, { workspaceId, turnId })) {
    await db.outboxEvent.update({ where: { id: event.id }, data: { publishedAt: new Date(), lastError: "dead_letter_invalid_conversation_event" } });
    if (turn?.status === "QUEUED") {
      await db.conversationTurn.update({ where: { id: turnId }, data: { status: "FAILED", failureCode: "invalid_outbox", failureMessage: "Conversation event integrity validation failed.", finishedAt: new Date(), stateVersion: { increment: 1 } } });
    }
    return null;
  }
  const now = new Date();
  if (event.availableAt > now) return null;
  const leaseUntil = new Date(now.getTime() + 60_000);
  const claimed = await db.outboxEvent.updateMany({
    where: { id: event.id, publishedAt: null, availableAt: { lte: now } },
    data: { availableAt: leaseUntil, attemptCount: { increment: 1 } },
  });
  if (claimed.count !== 1) return null;
  if (turn.status !== "QUEUED") {
    await db.outboxEvent.updateMany({
      where: { id: event.id, publishedAt: null, availableAt: leaseUntil },
      data: { publishedAt: new Date(), lastError: `canonical_${turn.status.toLowerCase()}` },
    });
    return null;
  }
  try {
    const durable = await start(executeConversationTurn, [workspaceId, turnId]);
    const payload = { ...(event.payload as Record<string, unknown>), executorRunId: durable.runId };
    const completed = await db.outboxEvent.updateMany({
      where: { id: event.id, publishedAt: null, availableAt: leaseUntil },
      data: { payload, payloadHash: createHash("sha256").update(canonicalJson(payload)).digest("hex"), publishedAt: new Date(), lastError: null },
    });
    if (completed.count !== 1) throw new Error("Conversation outbox publisher lease was lost.");
    return durable.runId;
  } catch {
    const delayMs = Math.min(5_000 * 2 ** Math.min(event.attemptCount, 6), 5 * 60_000);
    await db.outboxEvent.updateMany({
      where: { id: event.id, publishedAt: null, availableAt: leaseUntil },
      data: { availableAt: new Date(Date.now() + delayMs), lastError: "conversation_dispatch_failed" },
    });
    return null;
  }
}

export async function reconcileConversationOutbox(limit = 50) {
  const db = getDb();
  const now = new Date();
  const pending = await db.outboxEvent.findMany({
    where: { aggregateType: "conversation_turn", eventType: "conversation.turn.queued", publishedAt: null, availableAt: { lte: now } },
    orderBy: { availableAt: "asc" },
    take: Math.min(limit, 100),
  });
  let dispatched = 0;
  for (const event of pending) if (await dispatchConversationTurn(event.workspaceId, event.aggregateId)) dispatched += 1;
  return { inspected: pending.length, dispatched, pending: pending.length - dispatched };
}
