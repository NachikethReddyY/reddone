import "server-only";

import { createHash } from "node:crypto";

import type { ProjectAuthorityMode, Prisma } from "@prisma/client";

import { getDb } from "@/server/db";
import { canonicalJson } from "@/server/security/canonical-json";
import { withSerializableTransaction } from "@/server/transactions";

const ACTIVE_TURN_STATUSES = ["QUEUED", "RUNNING", "CANCEL_REQUESTED"] as const;

function hashContent(content: string) {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function serializeConversation(conversation: {
  id: string;
  projectId: string;
  title: string;
  archivedAt: Date | null;
  optimisticVersion: number;
  lastActivityAt: Date;
  createdAt: Date;
  updatedAt: Date;
  turns?: Array<{ id: string; status: string }>;
}) {
  const active = conversation.turns?.[0] ?? null;
  return {
    id: conversation.id,
    projectId: conversation.projectId,
    title: conversation.title,
    archivedAt: conversation.archivedAt?.toISOString() ?? null,
    optimisticVersion: conversation.optimisticVersion,
    lastActivityAt: conversation.lastActivityAt.toISOString(),
    activeTurn: active ? { id: active.id, status: active.status.toLowerCase() } : null,
    createdAt: conversation.createdAt.toISOString(),
    updatedAt: conversation.updatedAt.toISOString(),
  };
}

export async function listProjectConversations(input: { workspaceId: string; projectId: string }) {
  const conversations = await getDb().projectConversation.findMany({
    where: { workspaceId: input.workspaceId, projectId: input.projectId },
    include: {
      turns: {
        where: { status: { in: [...ACTIVE_TURN_STATUSES] } },
        select: { id: true, status: true },
        take: 1,
      },
    },
    orderBy: [{ archivedAt: "asc" }, { lastActivityAt: "desc" }],
    take: 100,
  });
  return conversations.map(serializeConversation);
}

export async function createProjectConversation(input: {
  workspaceId: string;
  projectId: string;
  title: string;
}) {
  return withSerializableTransaction(getDb(), async (tx) => {
    const project = await tx.project.findUnique({
      where: { workspaceId_id: { workspaceId: input.workspaceId, id: input.projectId } },
      select: { id: true, archivedAt: true, status: true },
    });
    if (!project || project.archivedAt || project.status === "ARCHIVED") throw new Error("Project not found.");
    const conversation = await tx.projectConversation.create({
      data: { workspaceId: input.workspaceId, projectId: input.projectId, title: input.title },
      include: { turns: { where: { status: { in: [...ACTIVE_TURN_STATUSES] } }, select: { id: true, status: true }, take: 1 } },
    });
    return serializeConversation(conversation);
  });
}

export async function getProjectConversation(input: {
  workspaceId: string;
  projectId: string;
  conversationId: string;
  cursor?: number;
  limit?: number;
}) {
  const limit = Math.min(input.limit ?? 50, 100);
  const conversation = await getDb().projectConversation.findUnique({
    where: { workspaceId_projectId_id: { workspaceId: input.workspaceId, projectId: input.projectId, id: input.conversationId } },
    include: {
      turns: {
        where: { status: { in: [...ACTIVE_TURN_STATUSES] } },
        select: { id: true, status: true, authorityMode: true, projectVersion: true, cancelRequestedAt: true, createdAt: true, startedAt: true, finishedAt: true },
        take: 1,
      },
      messages: {
        ...(input.cursor ? { where: { sequence: { lt: input.cursor } } } : {}),
        orderBy: { sequence: "desc" },
        take: limit + 1,
      },
      actions: {
        where: { status: { in: ["PROPOSED", "EXECUTING"] } },
        orderBy: { createdAt: "desc" },
        take: 100,
      },
    },
  });
  if (!conversation) return null;
  const messages = conversation.messages.slice(0, limit).reverse();
  return {
    conversation: serializeConversation(conversation),
    messages: messages.map((message) => ({
      id: message.id,
      sequence: message.sequence,
      role: message.role.toLowerCase(),
      content: message.content,
      createdAt: message.createdAt.toISOString(),
    })),
    nextCursor: conversation.messages.length > limit ? String(conversation.messages[limit - 1]?.sequence ?? "") : null,
    activeTurn: conversation.turns[0]
      ? {
          id: conversation.turns[0].id,
          status: conversation.turns[0].status.toLowerCase(),
          authorityMode: conversation.turns[0].authorityMode.toLowerCase(),
          projectVersion: conversation.turns[0].projectVersion,
          streamUrl: `/api/v1/projects/${input.projectId}/conversation/${conversation.id}/turns/${conversation.turns[0].id}/events`,
          cancelRequestedAt: conversation.turns[0].cancelRequestedAt?.toISOString() ?? null,
          createdAt: conversation.turns[0].createdAt.toISOString(),
          startedAt: conversation.turns[0].startedAt?.toISOString() ?? null,
          finishedAt: conversation.turns[0].finishedAt?.toISOString() ?? null,
        }
      : null,
    actions: conversation.actions.map((action) => ({
      id: action.id,
      command: action.command,
      schemaVersion: action.schemaVersion,
      risk: action.risk.toLowerCase(),
      status: action.status.toLowerCase(),
      expectedProjectVersion: action.expectedProjectVersion,
      diff: action.diff,
      expiresAt: action.expiresAt.toISOString(),
      createdAt: action.createdAt.toISOString(),
    })),
  };
}

export async function createConversationTurn(input: {
  workspaceId: string;
  projectId: string;
  conversationId: string;
  ownerUserId: string;
  message: string;
  idempotencyKey: string;
  expectedProjectVersion: number;
}) {
  return withSerializableTransaction(getDb(), async (tx) => {
    const existing = await tx.conversationTurn.findUnique({
      where: { workspaceId_idempotencyKey: { workspaceId: input.workspaceId, idempotencyKey: input.idempotencyKey } },
    });
    if (existing) {
      if (existing.projectId !== input.projectId || existing.conversationId !== input.conversationId) {
        throw new Error("Idempotency key conflict: this key was used for a different conversation turn.");
      }
      return { turn: existing, replayed: true };
    }
    const project = await tx.project.findUnique({
      where: { workspaceId_id: { workspaceId: input.workspaceId, id: input.projectId } },
      select: { optimisticVersion: true, authorityMode: true, archivedAt: true, status: true },
    });
    if (!project || project.archivedAt || project.status === "ARCHIVED") throw new Error("Project not found.");
    if (project.optimisticVersion !== input.expectedProjectVersion) throw new Error("Project version conflict.");
    const conversation = await tx.projectConversation.findUnique({
      where: { workspaceId_projectId_id: { workspaceId: input.workspaceId, projectId: input.projectId, id: input.conversationId } },
      select: { id: true, archivedAt: true },
    });
    if (!conversation || conversation.archivedAt) throw new Error("Conversation not found.");
    const active = await tx.conversationTurn.findFirst({
      where: { workspaceId: input.workspaceId, projectId: input.projectId, conversationId: input.conversationId, status: { in: [...ACTIVE_TURN_STATUSES] } },
      select: { id: true },
    });
    if (active) throw new Error("This conversation already has an active turn.");
    const next = await tx.conversationMessage.aggregate({
      where: { workspaceId: input.workspaceId, projectId: input.projectId, conversationId: input.conversationId },
      _max: { sequence: true },
    });
    const ownerMessage = await tx.conversationMessage.create({
      data: {
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        conversationId: input.conversationId,
        sequence: (next._max.sequence ?? 0) + 1,
        role: "OWNER",
        authorUserId: input.ownerUserId,
        content: input.message,
        contentHash: hashContent(input.message),
      },
    });
    const turn = await tx.conversationTurn.create({
      data: {
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        conversationId: input.conversationId,
        ownerMessageId: ownerMessage.id,
        idempotencyKey: input.idempotencyKey,
        authorityMode: project.authorityMode as ProjectAuthorityMode,
        projectVersion: project.optimisticVersion,
      },
    });
    await tx.projectConversation.update({
      where: { id: conversation.id },
      data: { lastActivityAt: new Date(), optimisticVersion: { increment: 1 } },
    });
    const outboxPayload = { schemaVersion: 1, workspaceId: input.workspaceId, projectId: input.projectId, conversationId: input.conversationId, turnId: turn.id };
    await tx.outboxEvent.create({
      data: {
        workspaceId: input.workspaceId,
        aggregateType: "conversation_turn",
        aggregateId: turn.id,
        aggregateVersion: turn.stateVersion,
        eventType: "conversation.turn.queued",
        payload: outboxPayload,
        payloadHash: hashContent(canonicalJson(outboxPayload)),
        idempotencyKey: `${input.idempotencyKey}:outbox`,
      },
    });
    return { turn, replayed: false };
  });
}

export async function requestConversationTurnCancellation(input: { workspaceId: string; projectId: string; conversationId: string; turnId: string; expectedProjectVersion: number }) {
  const project = await getDb().project.findUnique({
    where: { workspaceId_id: { workspaceId: input.workspaceId, id: input.projectId } },
    select: { optimisticVersion: true },
  });
  if (!project || project.optimisticVersion !== input.expectedProjectVersion) throw new Error("Project version conflict.");
  const updated = await getDb().conversationTurn.updateMany({
    where: {
      id: input.turnId,
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      conversationId: input.conversationId,
      status: { in: ["QUEUED", "RUNNING"] },
    },
    data: { status: "CANCEL_REQUESTED", cancelRequestedAt: new Date(), stateVersion: { increment: 1 } },
  });
  if (updated.count !== 1) throw new Error("The conversation turn cannot be canceled.");
}

export async function listConversationActivity(input: { workspaceId: string; projectId: string; cursor?: bigint; limit?: number }) {
  const rows = await getDb().activityEvent.findMany({
    where: { workspaceId: input.workspaceId, projectId: input.projectId, ...(input.cursor ? { sequence: { lt: input.cursor } } : {}) },
    orderBy: { sequence: "desc" },
    take: Math.min(input.limit ?? 50, 100) + 1,
  });
  const items = rows.slice(0, Math.min(input.limit ?? 50, 100));
  return {
    items: items.map((event) => ({
      id: event.id,
      type: event.type,
      severity: event.severity.toLowerCase(),
      message: event.message,
      createdAt: event.createdAt.toISOString(),
    })),
    nextCursor: rows.length > items.length ? items.at(-1)?.sequence.toString() ?? null : null,
  };
}

export type ConversationTransaction = Prisma.TransactionClient;
