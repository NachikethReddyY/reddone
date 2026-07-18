-- Additive, fail-closed project conversation domain.
CREATE TYPE "ProjectAuthorityMode" AS ENUM ('READ_ONLY', 'REVIEW', 'AUTOPILOT');
CREATE TYPE "ConversationMessageRole" AS ENUM ('OWNER', 'ASSISTANT', 'SYSTEM');
CREATE TYPE "ConversationTurnStatus" AS ENUM ('QUEUED', 'RUNNING', 'CANCEL_REQUESTED', 'CANCELED', 'COMPLETED', 'FAILED');
CREATE TYPE "ConversationEventType" AS ENUM ('TURN_STARTED', 'AGENT_STATUS', 'TOOL_STARTED', 'TOOL_COMPLETED', 'ASSISTANT_DELTA', 'ACTION_PROPOSED', 'ASSISTANT_COMPLETED', 'TURN_FAILED', 'TURN_CANCELED', 'TURN_COMPLETED');
CREATE TYPE "ConversationActionRisk" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'BLOCKED');
CREATE TYPE "ConversationActionStatus" AS ENUM ('PROPOSED', 'EXECUTING', 'EXECUTED', 'DISMISSED', 'EXPIRED', 'SUPERSEDED', 'FAILED');

ALTER TABLE "projects"
  ADD COLUMN "authorityMode" "ProjectAuthorityMode" NOT NULL DEFAULT 'READ_ONLY';

CREATE TABLE "project_conversations" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "workspaceId" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "title" VARCHAR(120) NOT NULL,
  "summary" TEXT,
  "optimisticVersion" INTEGER NOT NULL DEFAULT 0,
  "archivedAt" TIMESTAMPTZ(6),
  "lastActivityAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "project_conversations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "project_conversations_workspace_project_id_key" UNIQUE ("workspaceId", "projectId", "id"),
  CONSTRAINT "project_conversations_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "project_conversations_workspace_project_fkey" FOREIGN KEY ("workspaceId", "projectId") REFERENCES "projects"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "project_conversations_workspace_project_activity_idx" ON "project_conversations"("workspaceId", "projectId", "archivedAt", "lastActivityAt" DESC);

CREATE TABLE "conversation_messages" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "workspaceId" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "conversationId" UUID NOT NULL,
  "sequence" INTEGER NOT NULL,
  "role" "ConversationMessageRole" NOT NULL,
  "authorUserId" TEXT,
  "content" TEXT NOT NULL,
  "contentHash" CHAR(64) NOT NULL,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "conversation_messages_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "conversation_messages_workspace_project_id_key" UNIQUE ("workspaceId", "projectId", "id"),
  CONSTRAINT "conversation_messages_sequence_key" UNIQUE ("workspaceId", "projectId", "conversationId", "sequence"),
  CONSTRAINT "conversation_messages_conversation_fkey" FOREIGN KEY ("workspaceId", "projectId", "conversationId") REFERENCES "project_conversations"("workspaceId", "projectId", "id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "conversation_messages_conversation_created_idx" ON "conversation_messages"("workspaceId", "projectId", "conversationId", "createdAt");

CREATE TABLE "conversation_turns" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "workspaceId" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "conversationId" UUID NOT NULL,
  "ownerMessageId" UUID NOT NULL,
  "status" "ConversationTurnStatus" NOT NULL DEFAULT 'QUEUED',
  "stateVersion" INTEGER NOT NULL DEFAULT 0,
  "idempotencyKey" VARCHAR(200) NOT NULL,
  "authorityMode" "ProjectAuthorityMode" NOT NULL,
  "projectVersion" INTEGER NOT NULL,
  "modelVersion" VARCHAR(120),
  "promptVersion" VARCHAR(100),
  "toolsetVersion" VARCHAR(100),
  "policyVersion" VARCHAR(100),
  "budgetCeilingMicros" BIGINT NOT NULL DEFAULT 0,
  "actualCostMicros" BIGINT NOT NULL DEFAULT 0,
  "partialResponse" TEXT,
  "cancelRequestedAt" TIMESTAMPTZ(6),
  "startedAt" TIMESTAMPTZ(6),
  "finishedAt" TIMESTAMPTZ(6),
  "failureCode" VARCHAR(100),
  "failureMessage" VARCHAR(1000),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "conversation_turns_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "conversation_turns_workspace_idempotency_key" UNIQUE ("workspaceId", "idempotencyKey"),
  CONSTRAINT "conversation_turns_workspace_project_id_key" UNIQUE ("workspaceId", "projectId", "id"),
  CONSTRAINT "conversation_turns_conversation_fkey" FOREIGN KEY ("workspaceId", "projectId", "conversationId") REFERENCES "project_conversations"("workspaceId", "projectId", "id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "conversation_turns_conversation_status_created_idx" ON "conversation_turns"("workspaceId", "projectId", "conversationId", "status", "createdAt" DESC);
CREATE UNIQUE INDEX "conversation_turns_one_active_per_conversation"
  ON "conversation_turns"("workspaceId", "projectId", "conversationId")
  WHERE "status" IN ('QUEUED', 'RUNNING', 'CANCEL_REQUESTED');

CREATE TABLE "conversation_turn_events" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "workspaceId" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "turnId" UUID NOT NULL,
  "sequence" BIGSERIAL NOT NULL,
  "type" "ConversationEventType" NOT NULL,
  "payload" JSONB NOT NULL DEFAULT '{}',
  "expiresAt" TIMESTAMPTZ(6),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "conversation_turn_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "conversation_turn_events_sequence_key" UNIQUE ("workspaceId", "turnId", "sequence"),
  CONSTRAINT "conversation_turn_events_turn_fkey" FOREIGN KEY ("workspaceId", "projectId", "turnId") REFERENCES "conversation_turns"("workspaceId", "projectId", "id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "conversation_turn_events_turn_sequence_idx" ON "conversation_turn_events"("workspaceId", "projectId", "turnId", "sequence");
CREATE INDEX "conversation_turn_events_expiry_idx" ON "conversation_turn_events"("expiresAt");

CREATE TABLE "conversation_actions" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "workspaceId" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "conversationId" UUID NOT NULL,
  "turnId" UUID,
  "command" VARCHAR(100) NOT NULL,
  "schemaVersion" VARCHAR(50) NOT NULL,
  "payload" JSONB NOT NULL DEFAULT '{}',
  "payloadHash" CHAR(64) NOT NULL,
  "expectedProjectVersion" INTEGER NOT NULL,
  "risk" "ConversationActionRisk" NOT NULL,
  "status" "ConversationActionStatus" NOT NULL DEFAULT 'PROPOSED',
  "diff" JSONB NOT NULL DEFAULT '{}',
  "expiresAt" TIMESTAMPTZ(6) NOT NULL,
  "result" JSONB,
  "auditEventId" UUID,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "conversation_actions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "conversation_actions_workspace_project_id_key" UNIQUE ("workspaceId", "projectId", "id"),
  CONSTRAINT "conversation_actions_conversation_fkey" FOREIGN KEY ("workspaceId", "projectId", "conversationId") REFERENCES "project_conversations"("workspaceId", "projectId", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "conversation_actions_turn_fkey" FOREIGN KEY ("workspaceId", "projectId", "turnId") REFERENCES "conversation_turns"("workspaceId", "projectId", "id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "conversation_actions_conversation_status_expiry_idx" ON "conversation_actions"("workspaceId", "projectId", "conversationId", "status", "expiresAt");

CREATE TABLE "conversation_turn_leases" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "workspaceId" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "turnId" UUID NOT NULL UNIQUE,
  "ownerId" VARCHAR(200) NOT NULL,
  "fencingToken" BIGINT NOT NULL,
  "acquiredAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMPTZ(6) NOT NULL,
  "releasedAt" TIMESTAMPTZ(6),
  CONSTRAINT "conversation_turn_leases_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "conversation_turn_leases_workspace_project_turn_key" UNIQUE ("workspaceId", "projectId", "turnId"),
  CONSTRAINT "conversation_turn_leases_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "conversation_turn_leases_turn_fkey" FOREIGN KEY ("workspaceId", "projectId", "turnId") REFERENCES "conversation_turns"("workspaceId", "projectId", "id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "conversation_turn_leases_expiry_idx" ON "conversation_turn_leases"("workspaceId", "expiresAt", "releasedAt");
