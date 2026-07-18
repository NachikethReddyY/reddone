import { z } from "zod";

import { IdSchema, IsoDateTimeSchema, JsonValueSchema, OptimisticVersionSchema } from "./common";

export const ProjectAuthorityModeSchema = z.enum(["read_only", "review", "autopilot"]);
export const ConversationMessageRoleSchema = z.enum(["owner", "assistant", "system"]);
export const ConversationTurnStatusSchema = z.enum([
  "queued",
  "running",
  "cancel_requested",
  "canceled",
  "completed",
  "failed",
]);
export const ConversationEventTypeSchema = z.enum([
  "turn.started",
  "agent.status",
  "tool.started",
  "tool.completed",
  "assistant.delta",
  "action.proposed",
  "assistant.completed",
  "turn.failed",
  "turn.canceled",
  "turn.completed",
]);
export const ConversationActionRiskSchema = z.enum(["low", "medium", "high", "blocked"]);
export const ConversationActionStatusSchema = z.enum([
  "proposed",
  "executing",
  "executed",
  "dismissed",
  "expired",
  "superseded",
  "failed",
]);

export const ConversationTitleSchema = z.string().trim().min(1).max(120);
export const ConversationMessageContentSchema = z.string().trim().min(1).max(16_000);
export const ConversationCursorSchema = z.string().regex(/^\d+$/).max(20);

export const CreateConversationInputSchema = z.object({ title: ConversationTitleSchema }).strict();
export const CreateTurnInputSchema = z.object({ message: ConversationMessageContentSchema }).strict();

export const ConversationMessageSchema = z.object({
  id: IdSchema,
  sequence: z.number().int().positive(),
  role: ConversationMessageRoleSchema,
  content: z.string().max(16_000),
  createdAt: IsoDateTimeSchema,
}).strict();

export const ConversationThreadSchema = z.object({
  id: IdSchema,
  projectId: IdSchema,
  title: ConversationTitleSchema,
  archivedAt: IsoDateTimeSchema.nullable(),
  optimisticVersion: OptimisticVersionSchema,
  lastActivityAt: IsoDateTimeSchema,
  activeTurn: z.object({
    id: IdSchema,
    status: ConversationTurnStatusSchema,
  }).strict().nullable(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
}).strict();

export const ConversationActionSchema = z.object({
  id: IdSchema,
  command: z.string().trim().min(1).max(100),
  schemaVersion: z.string().trim().min(1).max(50),
  risk: ConversationActionRiskSchema,
  status: ConversationActionStatusSchema,
  expectedProjectVersion: OptimisticVersionSchema,
  diff: JsonValueSchema,
  expiresAt: IsoDateTimeSchema,
  createdAt: IsoDateTimeSchema,
}).strict();

export const ConversationTurnSchema = z.object({
  id: IdSchema,
  status: ConversationTurnStatusSchema,
  authorityMode: ProjectAuthorityModeSchema,
  projectVersion: OptimisticVersionSchema,
  streamUrl: z.string().url(),
  cancelRequestedAt: IsoDateTimeSchema.nullable(),
  createdAt: IsoDateTimeSchema,
  startedAt: IsoDateTimeSchema.nullable(),
  finishedAt: IsoDateTimeSchema.nullable(),
}).strict();

export const ConversationEventPayloadSchema = z.object({
  message: z.string().max(4_000).optional(),
  delta: z.string().max(2_000).optional(),
  actionId: IdSchema.optional(),
  status: ConversationTurnStatusSchema.optional(),
}).strict();

export const ConversationEventSchema = z.object({
  id: ConversationCursorSchema,
  type: ConversationEventTypeSchema,
  payload: ConversationEventPayloadSchema,
  createdAt: IsoDateTimeSchema,
}).strict();

export const ConversationDetailSchema = z.object({
  conversation: ConversationThreadSchema,
  messages: z.array(ConversationMessageSchema).max(100),
  nextCursor: ConversationCursorSchema.nullable(),
  activeTurn: ConversationTurnSchema.nullable(),
  actions: z.array(ConversationActionSchema).max(100),
}).strict();

export const ConversationActivitySchema = z.object({
  items: z.array(z.object({
    id: IdSchema,
    type: z.string().max(150),
    severity: z.enum(["debug", "info", "warning", "error", "success"]),
    message: z.string().max(4_000),
    createdAt: IsoDateTimeSchema,
  }).strict()).max(100),
  nextCursor: ConversationCursorSchema.nullable(),
}).strict();

export type ProjectAuthorityMode = z.infer<typeof ProjectAuthorityModeSchema>;
export type ConversationTurnStatus = z.infer<typeof ConversationTurnStatusSchema>;
export type ConversationEventType = z.infer<typeof ConversationEventTypeSchema>;
export type ConversationActionStatus = z.infer<typeof ConversationActionStatusSchema>;
export type ConversationThread = z.infer<typeof ConversationThreadSchema>;
export type ConversationTurn = z.infer<typeof ConversationTurnSchema>;
