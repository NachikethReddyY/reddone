import "server-only";

import type { ConversationEventType, Prisma } from "@prisma/client";

import { ConversationEventPayloadSchema, type ConversationEventType as PublicEventType } from "@/contracts";
import { getDb } from "@/server/db";
import { containsSecretLikeValue } from "@/server/security/redaction";

const eventTypeMap: Record<PublicEventType, ConversationEventType> = {
  "turn.started": "TURN_STARTED",
  "agent.status": "AGENT_STATUS",
  "tool.started": "TOOL_STARTED",
  "tool.completed": "TOOL_COMPLETED",
  "assistant.delta": "ASSISTANT_DELTA",
  "action.proposed": "ACTION_PROPOSED",
  "assistant.completed": "ASSISTANT_COMPLETED",
  "turn.failed": "TURN_FAILED",
  "turn.canceled": "TURN_CANCELED",
  "turn.completed": "TURN_COMPLETED",
};

const publicTypeMap = Object.fromEntries(Object.entries(eventTypeMap).map(([key, value]) => [value, key])) as Record<ConversationEventType, PublicEventType>;

export async function recordConversationEvent(input: {
  workspaceId: string;
  projectId: string;
  turnId: string;
  type: PublicEventType;
  payload: unknown;
  expiresAt?: Date;
}) {
  const payload = ConversationEventPayloadSchema.parse(input.payload);
  if (containsSecretLikeValue(payload)) throw new Error("Unsafe conversation event content was rejected.");
  return getDb().conversationTurnEvent.create({
    data: {
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      turnId: input.turnId,
      type: eventTypeMap[input.type],
      payload: payload as Prisma.InputJsonValue,
      ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
    },
  });
}

export async function listConversationEvents(input: {
  workspaceId: string;
  projectId: string;
  conversationId: string;
  turnId: string;
  cursor?: bigint;
  limit?: number;
}) {
  const events = await getDb().conversationTurnEvent.findMany({
    where: {
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      turnId: input.turnId,
      turn: { conversationId: input.conversationId },
      ...(input.cursor ? { sequence: { gt: input.cursor } } : {}),
    },
    orderBy: { sequence: "asc" },
    take: Math.min(input.limit ?? 100, 200),
  });
  return events.map((event) => ({
    id: event.sequence.toString(),
    type: publicTypeMap[event.type],
    payload: ConversationEventPayloadSchema.parse(event.payload),
    createdAt: event.createdAt.toISOString(),
  }));
}

export function serializeSseEvent(event: { id: string; type: PublicEventType; payload: unknown }) {
  return `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event.payload)}\n\n`;
}
