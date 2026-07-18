-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "WorkspaceStatus" AS ENUM ('ACTIVE', 'PAUSED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "Provider" AS ENUM ('KIMI', 'DAYTONA', 'REDDIT', 'GITHUB', 'VERCEL');

-- CreateEnum
CREATE TYPE "ConnectionHealth" AS ENUM ('DISCONNECTED', 'PENDING', 'HEALTHY', 'DEGRADED', 'REVOKED', 'MISCONFIGURED');

-- CreateEnum
CREATE TYPE "SecretScope" AS ENUM ('CONTROL_PLANE', 'PROJECT_RUNTIME');

-- CreateEnum
CREATE TYPE "ResearchMode" AS ENUM ('FIXTURE', 'AUTHORIZED_IMPORT', 'LIVE_REDDIT');

-- CreateEnum
CREATE TYPE "ResearchSourceStatus" AS ENUM ('ACTIVE', 'DISABLED', 'PURGE_PENDING', 'PURGED');

-- CreateEnum
CREATE TYPE "ResearchImportStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REJECTED', 'PURGED');

-- CreateEnum
CREATE TYPE "ProjectStatus" AS ENUM ('DRAFT', 'RESEARCHING', 'AWAITING_SPEC_APPROVAL', 'READY_TO_BUILD', 'BUILDING', 'AWAITING_RELEASE_APPROVAL', 'RELEASED', 'PAUSED', 'FAILED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "SpecStatus" AS ENUM ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'SUPERSEDED', 'REJECTED');

-- CreateEnum
CREATE TYPE "RunKind" AS ENUM ('RESEARCH', 'BUILD', 'POLISH', 'RELEASE', 'ROLLBACK');

-- CreateEnum
CREATE TYPE "RunStatus" AS ENUM ('QUEUED', 'RUNNING', 'WAITING_FOR_APPROVAL', 'CANCEL_REQUESTED', 'CANCELED', 'SUCCEEDED', 'FAILED');

-- CreateEnum
CREATE TYPE "StepStatus" AS ENUM ('PENDING', 'RUNNING', 'WAITING', 'SUCCEEDED', 'FAILED', 'CANCELED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "BudgetStatus" AS ENUM ('RESERVED', 'COMMITTED', 'RELEASED', 'EXCEEDED');

-- CreateEnum
CREATE TYPE "ApprovalKind" AS ENUM ('SPECIFICATION_BUILD', 'FIRST_RELEASE', 'POLISH_RELEASE', 'SECRET_GRANT', 'ROLLBACK');

-- CreateEnum
CREATE TYPE "ApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'EXPIRED', 'CONSUMED', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "ArtifactKind" AS ENUM ('SOURCE', 'VERIFIED_SOURCE', 'VERCEL_OUTPUT', 'PREVIEW_STATIC', 'LOG_EXPORT');

-- CreateEnum
CREATE TYPE "VerificationStatus" AS ENUM ('PENDING', 'PASSED', 'FAILED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "RepositoryStatus" AS ENUM ('PENDING', 'READY', 'FAILED', 'DISCONNECTED');

-- CreateEnum
CREATE TYPE "DeploymentStatus" AS ENUM ('QUEUED', 'UPLOADING', 'READY_UNPROMOTED', 'HEALTH_CHECKING', 'HEALTHY', 'FAILED', 'ROLLED_BACK', 'CANCELED');

-- CreateEnum
CREATE TYPE "GrantStatus" AS ENUM ('PENDING', 'ACTIVE', 'REVOKED', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "ScheduleKind" AS ENUM ('HOURLY_RESEARCH', 'FIVE_HOUR_POLISH');

-- CreateEnum
CREATE TYPE "ScheduleStatus" AS ENUM ('ENABLED', 'PAUSED', 'BACKING_OFF');

-- CreateEnum
CREATE TYPE "ActivitySeverity" AS ENUM ('DEBUG', 'INFO', 'WARNING', 'ERROR', 'SUCCESS');

-- CreateTable
CREATE TABLE "workspaces" (
    "id" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "status" "WorkspaceStatus" NOT NULL DEFAULT 'ACTIVE',
    "timeZone" VARCHAR(100) NOT NULL DEFAULT 'Asia/Singapore',
    "maxConcurrentSandboxes" INTEGER NOT NULL DEFAULT 2,
    "monthlyBudgetMicros" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "workspaces_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "workspaceId" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "email" VARCHAR(320) NOT NULL,
    "emailVerified" BOOLEAN NOT NULL DEFAULT false,
    "image" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" TEXT NOT NULL,
    "token" VARCHAR(255) NOT NULL,
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "ipAddress" VARCHAR(64),
    "userAgent" TEXT,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "accounts" (
    "id" TEXT NOT NULL,
    "accountId" VARCHAR(255) NOT NULL,
    "providerId" VARCHAR(100) NOT NULL,
    "userId" TEXT NOT NULL,
    "accessToken" TEXT,
    "refreshToken" TEXT,
    "idToken" TEXT,
    "accessTokenExpiresAt" TIMESTAMPTZ(6),
    "refreshTokenExpiresAt" TIMESTAMPTZ(6),
    "scope" TEXT,
    "password" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "verifications" (
    "id" TEXT NOT NULL,
    "identifier" VARCHAR(320) NOT NULL,
    "value" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "verifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rateLimit" (
    "id" TEXT NOT NULL,
    "key" VARCHAR(255) NOT NULL,
    "count" INTEGER NOT NULL,
    "lastRequest" BIGINT NOT NULL,

    CONSTRAINT "rateLimit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "setup_tokens" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "tokenHash" CHAR(64) NOT NULL,
    "failedAttempts" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMPTZ(6),
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "consumedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "setup_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provider_connections" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "provider" "Provider" NOT NULL,
    "health" "ConnectionHealth" NOT NULL DEFAULT 'DISCONNECTED',
    "accountExternalId" VARCHAR(300),
    "accountLabel" VARCHAR(300),
    "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "maskedSuffix" VARCHAR(4),
    "activeSecretVersionId" UUID,
    "pendingSecretVersionId" UUID,
    "authorizationRef" TEXT,
    "authorizedAt" TIMESTAMPTZ(6),
    "lastTestedAt" TIMESTAMPTZ(6),
    "lastHealthyAt" TIMESTAMPTZ(6),
    "failureCode" VARCHAR(100),
    "failureMessage" VARCHAR(500),
    "connectedAt" TIMESTAMPTZ(6),
    "disconnectedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "provider_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "secret_versions" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "projectId" UUID,
    "providerConnectionId" UUID,
    "scope" "SecretScope" NOT NULL,
    "logicalKey" VARCHAR(240) NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "version" INTEGER NOT NULL,
    "algorithm" VARCHAR(32) NOT NULL DEFAULT 'A256GCM',
    "keyProvider" VARCHAR(32) NOT NULL,
    "keyId" VARCHAR(500) NOT NULL,
    "ciphertext" BYTEA NOT NULL,
    "wrappedDataKey" BYTEA NOT NULL,
    "iv" BYTEA NOT NULL,
    "authTag" BYTEA NOT NULL,
    "wrapIv" BYTEA,
    "wrapAuthTag" BYTEA,
    "contextHash" CHAR(64) NOT NULL,
    "maskedSuffix" VARCHAR(4) NOT NULL,
    "createdByUserId" TEXT,
    "revokedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "secret_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "projects" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "slug" VARCHAR(80) NOT NULL,
    "marketLabel" VARCHAR(120) NOT NULL,
    "researchContext" TEXT NOT NULL,
    "researchMode" "ResearchMode" NOT NULL,
    "config" JSONB NOT NULL,
    "status" "ProjectStatus" NOT NULL DEFAULT 'DRAFT',
    "optimisticVersion" INTEGER NOT NULL DEFAULT 0,
    "currentBlocker" VARCHAR(500),
    "selectedFindingId" UUID,
    "currentSpecVersionId" UUID,
    "archivedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "research_sources" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "mode" "ResearchMode" NOT NULL,
    "status" "ResearchSourceStatus" NOT NULL DEFAULT 'ACTIVE',
    "label" VARCHAR(120) NOT NULL,
    "externalRef" VARCHAR(500),
    "authorizationReference" TEXT,
    "authorizedAt" TIMESTAMPTZ(6),
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "purgeRequestedAt" TIMESTAMPTZ(6),
    "purgedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "research_sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "research_imports" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "sourceId" UUID NOT NULL,
    "status" "ResearchImportStatus" NOT NULL DEFAULT 'PENDING',
    "schemaVersion" VARCHAR(50) NOT NULL,
    "objectKey" VARCHAR(1024) NOT NULL,
    "contentHash" CHAR(64) NOT NULL,
    "documentCount" INTEGER NOT NULL,
    "byteSize" INTEGER NOT NULL,
    "rawExpiresAt" TIMESTAMPTZ(6) NOT NULL,
    "rejectionCode" VARCHAR(100),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acceptedAt" TIMESTAMPTZ(6),
    "purgedAt" TIMESTAMPTZ(6),

    CONSTRAINT "research_imports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "research_documents" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "sourceId" UUID NOT NULL,
    "importId" UUID,
    "externalId" VARCHAR(300) NOT NULL,
    "title" VARCHAR(500) NOT NULL,
    "body" TEXT NOT NULL,
    "permalink" TEXT,
    "attribution" VARCHAR(300) NOT NULL,
    "contentHash" CHAR(64) NOT NULL,
    "sourcePublishedAt" TIMESTAMPTZ(6),
    "rawExpiresAt" TIMESTAMPTZ(6) NOT NULL,
    "purgedAt" TIMESTAMPTZ(6),
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "research_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "findings" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "problemSummary" TEXT NOT NULL,
    "audience" TEXT NOT NULL,
    "originMode" "ResearchMode" NOT NULL DEFAULT 'FIXTURE',
    "frequencyScore" DECIMAL(5,2) NOT NULL,
    "severityScore" DECIMAL(5,2) NOT NULL,
    "willingnessToPayScore" DECIMAL(5,2) NOT NULL,
    "feasibilityScore" DECIMAL(5,2) NOT NULL,
    "totalScore" DECIMAL(5,2) NOT NULL,
    "scoreExplanation" TEXT NOT NULL,
    "selectedAt" TIMESTAMPTZ(6),
    "model" VARCHAR(120) NOT NULL,
    "promptVersion" VARCHAR(100) NOT NULL,
    "schemaVersion" VARCHAR(100) NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "findings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "evidence_excerpts" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "findingId" UUID NOT NULL,
    "sourceExternalId" VARCHAR(300) NOT NULL,
    "excerpt" VARCHAR(1500) NOT NULL,
    "permalink" TEXT,
    "attribution" VARCHAR(300) NOT NULL,
    "contentHash" CHAR(64) NOT NULL,
    "sourcePublishedAt" TIMESTAMPTZ(6),
    "capturedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "retainedBySpecVersionId" UUID,

    CONSTRAINT "evidence_excerpts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_spec_versions" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "basedOnFindingId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "optimisticVersion" INTEGER NOT NULL DEFAULT 0,
    "status" "SpecStatus" NOT NULL DEFAULT 'DRAFT',
    "content" JSONB NOT NULL,
    "contentHash" CHAR(64) NOT NULL,
    "model" VARCHAR(120),
    "promptVersion" VARCHAR(100),
    "schemaVersion" VARCHAR(100) NOT NULL,
    "createdByUserId" TEXT,
    "approvedAt" TIMESTAMPTZ(6),
    "supersededAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "product_spec_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_runs" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "specVersionId" UUID,
    "parentRunId" UUID,
    "scheduleId" UUID,
    "kind" "RunKind" NOT NULL,
    "status" "RunStatus" NOT NULL DEFAULT 'QUEUED',
    "stateVersion" INTEGER NOT NULL DEFAULT 0,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "currentStepKey" VARCHAR(100),
    "idempotencyKey" VARCHAR(200) NOT NULL,
    "budgetCeilingMicros" BIGINT NOT NULL,
    "reservedMicros" BIGINT NOT NULL DEFAULT 0,
    "actualCostMicros" BIGINT NOT NULL DEFAULT 0,
    "cancelRequestedAt" TIMESTAMPTZ(6),
    "startedAt" TIMESTAMPTZ(6),
    "finishedAt" TIMESTAMPTZ(6),
    "lastHeartbeatAt" TIMESTAMPTZ(6),
    "failureCode" VARCHAR(100),
    "failureMessage" VARCHAR(1000),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "workflow_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_steps" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "runId" UUID NOT NULL,
    "key" VARCHAR(100) NOT NULL,
    "label" VARCHAR(200) NOT NULL,
    "status" "StepStatus" NOT NULL DEFAULT 'PENDING',
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "inputHash" CHAR(64),
    "output" JSONB,
    "outputHash" CHAR(64),
    "startedAt" TIMESTAMPTZ(6),
    "finishedAt" TIMESTAMPTZ(6),
    "failureCode" VARCHAR(100),
    "failureMessage" VARCHAR(1000),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "workflow_steps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "run_leases" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "projectId" UUID,
    "runId" UUID,
    "resourceKey" VARCHAR(300) NOT NULL,
    "ownerId" VARCHAR(200) NOT NULL,
    "fencingToken" BIGINT NOT NULL,
    "acquiredAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "releasedAt" TIMESTAMPTZ(6),

    CONSTRAINT "run_leases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbox_events" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "aggregateType" VARCHAR(100) NOT NULL,
    "aggregateId" VARCHAR(128) NOT NULL,
    "aggregateVersion" INTEGER NOT NULL,
    "eventType" VARCHAR(150) NOT NULL,
    "payload" JSONB NOT NULL,
    "payloadHash" CHAR(64) NOT NULL,
    "idempotencyKey" VARCHAR(200) NOT NULL,
    "availableAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedAt" TIMESTAMPTZ(6),
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "lastError" VARCHAR(1000),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inbox_receipts" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "consumer" VARCHAR(150) NOT NULL,
    "messageId" VARCHAR(300) NOT NULL,
    "payloadHash" CHAR(64) NOT NULL,
    "receivedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMPTZ(6),

    CONSTRAINT "inbox_receipts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "budget_reservations" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "runId" UUID NOT NULL,
    "provider" "Provider" NOT NULL,
    "idempotencyKey" VARCHAR(200) NOT NULL,
    "reservedMicros" BIGINT NOT NULL,
    "actualMicros" BIGINT,
    "status" "BudgetStatus" NOT NULL DEFAULT 'RESERVED',
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "committedAt" TIMESTAMPTZ(6),
    "releasedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "budget_reservations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "usage_ledger" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "runId" UUID NOT NULL,
    "provider" "Provider" NOT NULL,
    "externalUsageId" VARCHAR(300),
    "operation" VARCHAR(150) NOT NULL,
    "inputUnits" BIGINT NOT NULL DEFAULT 0,
    "outputUnits" BIGINT NOT NULL DEFAULT 0,
    "costMicros" BIGINT NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "occurredAt" TIMESTAMPTZ(6) NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "usage_ledger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approvals" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "kind" "ApprovalKind" NOT NULL,
    "status" "ApprovalStatus" NOT NULL DEFAULT 'PENDING',
    "optimisticVersion" INTEGER NOT NULL DEFAULT 0,
    "payload" JSONB NOT NULL,
    "payloadCanonical" TEXT NOT NULL,
    "payloadHash" CHAR(64) NOT NULL,
    "specVersionId" UUID,
    "artifactId" UUID,
    "upstreamArtifactId" UUID,
    "decidedByUserId" TEXT,
    "decisionReason" TEXT,
    "decidedAt" TIMESTAMPTZ(6),
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "consumedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "approvals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "build_artifacts" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "runId" UUID NOT NULL,
    "kind" "ArtifactKind" NOT NULL,
    "objectKey" VARCHAR(1024) NOT NULL,
    "artifactHash" CHAR(64) NOT NULL,
    "manifestHash" CHAR(64) NOT NULL,
    "byteSize" BIGINT NOT NULL,
    "fileCount" INTEGER NOT NULL,
    "signature" TEXT,
    "signatureKeyId" VARCHAR(500),
    "expiresAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "build_artifacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "verification_reports" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "artifactId" UUID NOT NULL,
    "status" "VerificationStatus" NOT NULL DEFAULT 'PENDING',
    "verifierImage" VARCHAR(500) NOT NULL,
    "report" JSONB NOT NULL,
    "reportHash" CHAR(64) NOT NULL,
    "signature" TEXT NOT NULL,
    "signatureKeyId" VARCHAR(500) NOT NULL,
    "verifiedAt" TIMESTAMPTZ(6),
    "expiresAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "verification_reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "repository_bindings" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "provider" "Provider" NOT NULL DEFAULT 'GITHUB',
    "installationId" VARCHAR(300) NOT NULL,
    "externalRepositoryId" VARCHAR(300),
    "owner" VARCHAR(200) NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "visibility" VARCHAR(20) NOT NULL DEFAULT 'private',
    "defaultBranch" VARCHAR(200) NOT NULL DEFAULT 'main',
    "status" "RepositoryStatus" NOT NULL DEFAULT 'PENDING',
    "optimisticVersion" INTEGER NOT NULL DEFAULT 0,
    "lastCommitSha" VARCHAR(64),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "repository_bindings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deployments" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "artifactId" UUID NOT NULL,
    "previousDeploymentId" UUID,
    "externalProjectId" VARCHAR(300) NOT NULL,
    "externalDeploymentId" VARCHAR(300) NOT NULL,
    "teamId" VARCHAR(300) NOT NULL,
    "environment" VARCHAR(50) NOT NULL,
    "status" "DeploymentStatus" NOT NULL DEFAULT 'QUEUED',
    "optimisticVersion" INTEGER NOT NULL DEFAULT 0,
    "artifactHash" CHAR(64) NOT NULL,
    "url" TEXT,
    "healthCheckUrl" TEXT,
    "healthFailure" VARCHAR(1000),
    "lastKnownGood" BOOLEAN NOT NULL DEFAULT false,
    "promotedAt" TIMESTAMPTZ(6),
    "rolledBackAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "deployments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_secret_grants" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "deploymentId" UUID,
    "secretVersionId" UUID NOT NULL,
    "approvalId" UUID NOT NULL,
    "status" "GrantStatus" NOT NULL DEFAULT 'PENDING',
    "grantedAt" TIMESTAMPTZ(6),
    "revokedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_secret_grants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "schedules" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "kind" "ScheduleKind" NOT NULL,
    "status" "ScheduleStatus" NOT NULL DEFAULT 'PAUSED',
    "intervalMinutes" INTEGER NOT NULL,
    "timeZone" VARCHAR(100) NOT NULL DEFAULT 'Asia/Singapore',
    "optimisticVersion" INTEGER NOT NULL DEFAULT 0,
    "nextRunAt" TIMESTAMPTZ(6),
    "lastEnqueuedAt" TIMESTAMPTZ(6),
    "lastCompletedAt" TIMESTAMPTZ(6),
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "backoffUntil" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "schedules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "activity_events" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "projectId" UUID,
    "runId" UUID,
    "sequence" BIGSERIAL NOT NULL,
    "type" VARCHAR(150) NOT NULL,
    "severity" "ActivitySeverity" NOT NULL DEFAULT 'INFO',
    "message" VARCHAR(4000) NOT NULL,
    "data" JSONB NOT NULL DEFAULT '{}',
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "activity_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_events" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "actorUserId" TEXT,
    "action" VARCHAR(150) NOT NULL,
    "targetType" VARCHAR(100) NOT NULL,
    "targetId" VARCHAR(128) NOT NULL,
    "requestId" VARCHAR(200),
    "ipHash" CHAR(64),
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_workspaceId_key" ON "users"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_token_key" ON "sessions"("token");

-- CreateIndex
CREATE INDEX "sessions_userId_expiresAt_idx" ON "sessions"("userId", "expiresAt");

-- CreateIndex
CREATE INDEX "accounts_userId_idx" ON "accounts"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "accounts_providerId_accountId_key" ON "accounts"("providerId", "accountId");

-- CreateIndex
CREATE INDEX "verifications_identifier_expiresAt_idx" ON "verifications"("identifier", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "rateLimit_key_key" ON "rateLimit"("key");

-- CreateIndex
CREATE UNIQUE INDEX "setup_tokens_workspaceId_key" ON "setup_tokens"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "setup_tokens_tokenHash_key" ON "setup_tokens"("tokenHash");

-- CreateIndex
CREATE INDEX "setup_tokens_expiresAt_idx" ON "setup_tokens"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "provider_connections_activeSecretVersionId_key" ON "provider_connections"("activeSecretVersionId");

-- CreateIndex
CREATE UNIQUE INDEX "provider_connections_pendingSecretVersionId_key" ON "provider_connections"("pendingSecretVersionId");

-- CreateIndex
CREATE INDEX "provider_connections_workspaceId_health_idx" ON "provider_connections"("workspaceId", "health");

-- CreateIndex
CREATE UNIQUE INDEX "provider_connections_workspaceId_provider_key" ON "provider_connections"("workspaceId", "provider");

-- CreateIndex
CREATE INDEX "secret_versions_workspaceId_projectId_scope_revokedAt_idx" ON "secret_versions"("workspaceId", "projectId", "scope", "revokedAt");

-- CreateIndex
CREATE INDEX "secret_versions_providerConnectionId_idx" ON "secret_versions"("providerConnectionId");

-- CreateIndex
CREATE UNIQUE INDEX "secret_versions_workspaceId_projectId_id_key" ON "secret_versions"("workspaceId", "projectId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "secret_versions_workspaceId_logicalKey_version_key" ON "secret_versions"("workspaceId", "logicalKey", "version");

-- CreateIndex
CREATE INDEX "projects_workspaceId_status_updatedAt_idx" ON "projects"("workspaceId", "status", "updatedAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "projects_workspaceId_id_key" ON "projects"("workspaceId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "projects_workspaceId_slug_key" ON "projects"("workspaceId", "slug");

-- CreateIndex
CREATE INDEX "research_sources_workspaceId_projectId_status_idx" ON "research_sources"("workspaceId", "projectId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "research_sources_workspaceId_projectId_id_key" ON "research_sources"("workspaceId", "projectId", "id");

-- CreateIndex
CREATE INDEX "research_imports_rawExpiresAt_purgedAt_idx" ON "research_imports"("rawExpiresAt", "purgedAt");

-- CreateIndex
CREATE UNIQUE INDEX "research_imports_workspaceId_projectId_id_key" ON "research_imports"("workspaceId", "projectId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "research_imports_workspaceId_projectId_contentHash_key" ON "research_imports"("workspaceId", "projectId", "contentHash");

-- CreateIndex
CREATE INDEX "research_documents_workspaceId_projectId_rawExpiresAt_idx" ON "research_documents"("workspaceId", "projectId", "rawExpiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "research_documents_workspaceId_projectId_sourceId_externalI_key" ON "research_documents"("workspaceId", "projectId", "sourceId", "externalId");

-- CreateIndex
CREATE INDEX "findings_workspaceId_projectId_totalScore_idx" ON "findings"("workspaceId", "projectId", "totalScore" DESC);

-- CreateIndex
CREATE INDEX "findings_workspaceId_originMode_idx" ON "findings"("workspaceId", "originMode");

-- CreateIndex
CREATE UNIQUE INDEX "findings_workspaceId_projectId_id_key" ON "findings"("workspaceId", "projectId", "id");

-- CreateIndex
CREATE INDEX "evidence_excerpts_workspaceId_projectId_retainedBySpecVersi_idx" ON "evidence_excerpts"("workspaceId", "projectId", "retainedBySpecVersionId");

-- CreateIndex
CREATE UNIQUE INDEX "evidence_excerpts_workspaceId_projectId_id_key" ON "evidence_excerpts"("workspaceId", "projectId", "id");

-- CreateIndex
CREATE INDEX "product_spec_versions_workspaceId_projectId_status_version_idx" ON "product_spec_versions"("workspaceId", "projectId", "status", "version" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "product_spec_versions_workspaceId_projectId_id_key" ON "product_spec_versions"("workspaceId", "projectId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "product_spec_versions_projectId_version_key" ON "product_spec_versions"("projectId", "version");

-- CreateIndex
CREATE INDEX "workflow_runs_workspaceId_projectId_status_createdAt_idx" ON "workflow_runs"("workspaceId", "projectId", "status", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "workflow_runs_workspaceId_status_lastHeartbeatAt_idx" ON "workflow_runs"("workspaceId", "status", "lastHeartbeatAt");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_runs_workspaceId_projectId_id_key" ON "workflow_runs"("workspaceId", "projectId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_runs_workspaceId_idempotencyKey_key" ON "workflow_runs"("workspaceId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "workflow_steps_workspaceId_runId_status_idx" ON "workflow_steps"("workspaceId", "runId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_steps_runId_key_attempt_key" ON "workflow_steps"("runId", "key", "attempt");

-- CreateIndex
CREATE INDEX "run_leases_workspaceId_expiresAt_releasedAt_idx" ON "run_leases"("workspaceId", "expiresAt", "releasedAt");

-- CreateIndex
CREATE UNIQUE INDEX "run_leases_workspaceId_resourceKey_key" ON "run_leases"("workspaceId", "resourceKey");

-- CreateIndex
CREATE INDEX "outbox_events_publishedAt_availableAt_idx" ON "outbox_events"("publishedAt", "availableAt");

-- CreateIndex
CREATE UNIQUE INDEX "outbox_events_workspaceId_idempotencyKey_key" ON "outbox_events"("workspaceId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "outbox_events_workspaceId_aggregateType_aggregateId_aggrega_key" ON "outbox_events"("workspaceId", "aggregateType", "aggregateId", "aggregateVersion");

-- CreateIndex
CREATE INDEX "inbox_receipts_workspaceId_processedAt_idx" ON "inbox_receipts"("workspaceId", "processedAt");

-- CreateIndex
CREATE UNIQUE INDEX "inbox_receipts_workspaceId_consumer_messageId_key" ON "inbox_receipts"("workspaceId", "consumer", "messageId");

-- CreateIndex
CREATE INDEX "budget_reservations_workspaceId_status_expiresAt_idx" ON "budget_reservations"("workspaceId", "status", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "budget_reservations_workspaceId_idempotencyKey_key" ON "budget_reservations"("workspaceId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "usage_ledger_workspaceId_occurredAt_idx" ON "usage_ledger"("workspaceId", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "usage_ledger_workspaceId_provider_externalUsageId_key" ON "usage_ledger"("workspaceId", "provider", "externalUsageId");

-- CreateIndex
CREATE INDEX "approvals_workspaceId_projectId_status_expiresAt_idx" ON "approvals"("workspaceId", "projectId", "status", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "approvals_workspaceId_projectId_id_key" ON "approvals"("workspaceId", "projectId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "approvals_workspaceId_projectId_payloadHash_key" ON "approvals"("workspaceId", "projectId", "payloadHash");

-- CreateIndex
CREATE INDEX "build_artifacts_workspaceId_projectId_createdAt_idx" ON "build_artifacts"("workspaceId", "projectId", "createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "build_artifacts_workspaceId_projectId_id_key" ON "build_artifacts"("workspaceId", "projectId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "build_artifacts_workspaceId_artifactHash_kind_key" ON "build_artifacts"("workspaceId", "artifactHash", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "verification_reports_artifactId_key" ON "verification_reports"("artifactId");

-- CreateIndex
CREATE INDEX "verification_reports_workspaceId_projectId_status_idx" ON "verification_reports"("workspaceId", "projectId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "verification_reports_workspaceId_projectId_artifactId_key" ON "verification_reports"("workspaceId", "projectId", "artifactId");

-- CreateIndex
CREATE UNIQUE INDEX "repository_bindings_projectId_key" ON "repository_bindings"("projectId");

-- CreateIndex
CREATE INDEX "repository_bindings_workspaceId_status_idx" ON "repository_bindings"("workspaceId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "repository_bindings_workspaceId_projectId_key" ON "repository_bindings"("workspaceId", "projectId");

-- CreateIndex
CREATE UNIQUE INDEX "repository_bindings_workspaceId_owner_name_key" ON "repository_bindings"("workspaceId", "owner", "name");

-- CreateIndex
CREATE INDEX "deployments_workspaceId_projectId_status_createdAt_idx" ON "deployments"("workspaceId", "projectId", "status", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "deployments_workspaceId_projectId_lastKnownGood_idx" ON "deployments"("workspaceId", "projectId", "lastKnownGood");

-- CreateIndex
CREATE UNIQUE INDEX "deployments_workspaceId_projectId_id_key" ON "deployments"("workspaceId", "projectId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "deployments_workspaceId_externalDeploymentId_key" ON "deployments"("workspaceId", "externalDeploymentId");

-- CreateIndex
CREATE INDEX "project_secret_grants_workspaceId_projectId_status_idx" ON "project_secret_grants"("workspaceId", "projectId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "project_secret_grants_projectId_deploymentId_secretVersionI_key" ON "project_secret_grants"("projectId", "deploymentId", "secretVersionId");

-- CreateIndex
CREATE INDEX "schedules_status_nextRunAt_idx" ON "schedules"("status", "nextRunAt");

-- CreateIndex
CREATE UNIQUE INDEX "schedules_workspaceId_projectId_id_key" ON "schedules"("workspaceId", "projectId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "schedules_projectId_kind_key" ON "schedules"("projectId", "kind");

-- CreateIndex
CREATE INDEX "activity_events_workspaceId_projectId_createdAt_idx" ON "activity_events"("workspaceId", "projectId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "activity_events_workspaceId_runId_sequence_idx" ON "activity_events"("workspaceId", "runId", "sequence");

-- CreateIndex
CREATE INDEX "activity_events_expiresAt_idx" ON "activity_events"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "activity_events_workspaceId_sequence_key" ON "activity_events"("workspaceId", "sequence");

-- CreateIndex
CREATE INDEX "audit_events_workspaceId_createdAt_idx" ON "audit_events"("workspaceId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "audit_events_expiresAt_idx" ON "audit_events"("expiresAt");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "setup_tokens" ADD CONSTRAINT "setup_tokens_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provider_connections" ADD CONSTRAINT "provider_connections_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provider_connections" ADD CONSTRAINT "provider_connections_activeSecretVersionId_fkey" FOREIGN KEY ("activeSecretVersionId") REFERENCES "secret_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provider_connections" ADD CONSTRAINT "provider_connections_pendingSecretVersionId_fkey" FOREIGN KEY ("pendingSecretVersionId") REFERENCES "secret_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "secret_versions" ADD CONSTRAINT "secret_versions_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "secret_versions" ADD CONSTRAINT "secret_versions_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "secret_versions" ADD CONSTRAINT "secret_versions_providerConnectionId_fkey" FOREIGN KEY ("providerConnectionId") REFERENCES "provider_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "research_sources" ADD CONSTRAINT "research_sources_workspaceId_projectId_fkey" FOREIGN KEY ("workspaceId", "projectId") REFERENCES "projects"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "research_imports" ADD CONSTRAINT "research_imports_workspaceId_projectId_fkey" FOREIGN KEY ("workspaceId", "projectId") REFERENCES "projects"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "research_imports" ADD CONSTRAINT "research_imports_workspaceId_projectId_sourceId_fkey" FOREIGN KEY ("workspaceId", "projectId", "sourceId") REFERENCES "research_sources"("workspaceId", "projectId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "research_documents" ADD CONSTRAINT "research_documents_workspaceId_projectId_sourceId_fkey" FOREIGN KEY ("workspaceId", "projectId", "sourceId") REFERENCES "research_sources"("workspaceId", "projectId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "research_documents" ADD CONSTRAINT "research_documents_importId_fkey" FOREIGN KEY ("importId") REFERENCES "research_imports"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "findings" ADD CONSTRAINT "findings_workspaceId_projectId_fkey" FOREIGN KEY ("workspaceId", "projectId") REFERENCES "projects"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evidence_excerpts" ADD CONSTRAINT "evidence_excerpts_workspaceId_projectId_findingId_fkey" FOREIGN KEY ("workspaceId", "projectId", "findingId") REFERENCES "findings"("workspaceId", "projectId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_spec_versions" ADD CONSTRAINT "product_spec_versions_workspaceId_projectId_fkey" FOREIGN KEY ("workspaceId", "projectId") REFERENCES "projects"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_spec_versions" ADD CONSTRAINT "product_spec_versions_workspaceId_projectId_basedOnFinding_fkey" FOREIGN KEY ("workspaceId", "projectId", "basedOnFindingId") REFERENCES "findings"("workspaceId", "projectId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_workspaceId_projectId_fkey" FOREIGN KEY ("workspaceId", "projectId") REFERENCES "projects"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_workspaceId_projectId_specVersionId_fkey" FOREIGN KEY ("workspaceId", "projectId", "specVersionId") REFERENCES "product_spec_versions"("workspaceId", "projectId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_workspaceId_projectId_parentRunId_fkey" FOREIGN KEY ("workspaceId", "projectId", "parentRunId") REFERENCES "workflow_runs"("workspaceId", "projectId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_workspaceId_projectId_scheduleId_fkey" FOREIGN KEY ("workspaceId", "projectId", "scheduleId") REFERENCES "schedules"("workspaceId", "projectId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_steps" ADD CONSTRAINT "workflow_steps_workspaceId_projectId_runId_fkey" FOREIGN KEY ("workspaceId", "projectId", "runId") REFERENCES "workflow_runs"("workspaceId", "projectId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "run_leases" ADD CONSTRAINT "run_leases_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outbox_events" ADD CONSTRAINT "outbox_events_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inbox_receipts" ADD CONSTRAINT "inbox_receipts_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budget_reservations" ADD CONSTRAINT "budget_reservations_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budget_reservations" ADD CONSTRAINT "budget_reservations_workspaceId_projectId_runId_fkey" FOREIGN KEY ("workspaceId", "projectId", "runId") REFERENCES "workflow_runs"("workspaceId", "projectId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_ledger" ADD CONSTRAINT "usage_ledger_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_ledger" ADD CONSTRAINT "usage_ledger_workspaceId_projectId_runId_fkey" FOREIGN KEY ("workspaceId", "projectId", "runId") REFERENCES "workflow_runs"("workspaceId", "projectId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_workspaceId_projectId_fkey" FOREIGN KEY ("workspaceId", "projectId") REFERENCES "projects"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_workspaceId_projectId_specVersionId_fkey" FOREIGN KEY ("workspaceId", "projectId", "specVersionId") REFERENCES "product_spec_versions"("workspaceId", "projectId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_workspaceId_projectId_artifactId_fkey" FOREIGN KEY ("workspaceId", "projectId", "artifactId") REFERENCES "build_artifacts"("workspaceId", "projectId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_workspaceId_projectId_upstreamArtifactId_fkey" FOREIGN KEY ("workspaceId", "projectId", "upstreamArtifactId") REFERENCES "build_artifacts"("workspaceId", "projectId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "build_artifacts" ADD CONSTRAINT "build_artifacts_workspaceId_projectId_runId_fkey" FOREIGN KEY ("workspaceId", "projectId", "runId") REFERENCES "workflow_runs"("workspaceId", "projectId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "verification_reports" ADD CONSTRAINT "verification_reports_workspaceId_projectId_artifactId_fkey" FOREIGN KEY ("workspaceId", "projectId", "artifactId") REFERENCES "build_artifacts"("workspaceId", "projectId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "repository_bindings" ADD CONSTRAINT "repository_bindings_workspaceId_projectId_fkey" FOREIGN KEY ("workspaceId", "projectId") REFERENCES "projects"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_workspaceId_projectId_fkey" FOREIGN KEY ("workspaceId", "projectId") REFERENCES "projects"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_workspaceId_projectId_artifactId_fkey" FOREIGN KEY ("workspaceId", "projectId", "artifactId") REFERENCES "build_artifacts"("workspaceId", "projectId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_workspaceId_projectId_previousDeploymentId_fkey" FOREIGN KEY ("workspaceId", "projectId", "previousDeploymentId") REFERENCES "deployments"("workspaceId", "projectId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_secret_grants" ADD CONSTRAINT "project_secret_grants_workspaceId_projectId_deploymentId_fkey" FOREIGN KEY ("workspaceId", "projectId", "deploymentId") REFERENCES "deployments"("workspaceId", "projectId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_secret_grants" ADD CONSTRAINT "project_secret_grants_workspaceId_projectId_secretVersionI_fkey" FOREIGN KEY ("workspaceId", "projectId", "secretVersionId") REFERENCES "secret_versions"("workspaceId", "projectId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_secret_grants" ADD CONSTRAINT "project_secret_grants_workspaceId_projectId_approvalId_fkey" FOREIGN KEY ("workspaceId", "projectId", "approvalId") REFERENCES "approvals"("workspaceId", "projectId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_workspaceId_projectId_fkey" FOREIGN KEY ("workspaceId", "projectId") REFERENCES "projects"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activity_events" ADD CONSTRAINT "activity_events_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ReDDone invariants not expressible in the Prisma schema.
ALTER TABLE "workspaces"
  ADD CONSTRAINT "workspaces_nonnegative_limits" CHECK ("maxConcurrentSandboxes" > 0 AND "monthlyBudgetMicros" >= 0);

ALTER TABLE "secret_versions"
  ADD CONSTRAINT "secret_scope_matches_project" CHECK (
    ("scope" = 'CONTROL_PLANE' AND "projectId" IS NULL) OR
    ("scope" = 'PROJECT_RUNTIME' AND "projectId" IS NOT NULL)
  ),
  ADD CONSTRAINT "secret_context_hash_is_sha256" CHECK ("contextHash" ~ '^[0-9a-f]{64}$');

ALTER TABLE "provider_connections"
  ADD CONSTRAINT "reddit_connection_requires_authorization" CHECK (
    "provider" <> 'REDDIT' OR "health" IN ('DISCONNECTED', 'PENDING') OR
    ("authorizationRef" IS NOT NULL AND "authorizedAt" IS NOT NULL)
  );

ALTER TABLE "research_sources"
  ADD CONSTRAINT "live_reddit_requires_authorization" CHECK (
    "mode" <> 'LIVE_REDDIT' OR ("authorizationReference" IS NOT NULL AND "authorizedAt" IS NOT NULL)
  );

ALTER TABLE "findings"
  ADD CONSTRAINT "finding_scores_in_range" CHECK (
    "frequencyScore" BETWEEN 0 AND 100 AND
    "severityScore" BETWEEN 0 AND 100 AND
    "willingnessToPayScore" BETWEEN 0 AND 100 AND
    "feasibilityScore" BETWEEN 0 AND 100 AND
    "totalScore" BETWEEN 0 AND 100
  );

ALTER TABLE "workflow_runs"
  ADD CONSTRAINT "workflow_run_budget_nonnegative" CHECK (
    "budgetCeilingMicros" >= 0 AND "reservedMicros" >= 0 AND "actualCostMicros" >= 0
  );

ALTER TABLE "budget_reservations"
  ADD CONSTRAINT "budget_reservation_nonnegative" CHECK (
    "reservedMicros" >= 0 AND ("actualMicros" IS NULL OR "actualMicros" >= 0)
  );

ALTER TABLE "build_artifacts"
  ADD CONSTRAINT "artifact_sizes_nonnegative" CHECK ("byteSize" >= 0 AND "fileCount" >= 0);

ALTER TABLE "approvals"
  ADD CONSTRAINT "approval_payload_hash_is_sha256" CHECK ("payloadHash" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "approval_resolution_is_complete" CHECK (
    ("status" = 'PENDING' AND "decidedAt" IS NULL) OR
    ("status" IN ('APPROVED', 'REJECTED', 'CONSUMED') AND "decidedAt" IS NOT NULL) OR
    "status" IN ('EXPIRED', 'SUPERSEDED')
  );

ALTER TABLE "repository_bindings"
  ADD CONSTRAINT "repositories_are_private" CHECK ("visibility" = 'private');

ALTER TABLE "deployments"
  ADD CONSTRAINT "known_deployment_environment" CHECK ("environment" IN ('preview', 'production'));

ALTER TABLE "schedules"
  ADD CONSTRAINT "schedule_interval_matches_kind" CHECK (
    ("kind" = 'HOURLY_RESEARCH' AND "intervalMinutes" = 60) OR
    ("kind" = 'FIVE_HOUR_POLISH' AND "intervalMinutes" = 300)
  );

-- Pointers that reuse the owning project id are constrained to that same project.
ALTER TABLE "projects"
  ADD CONSTRAINT "projects_selected_finding_same_project_fkey"
    FOREIGN KEY ("workspaceId", "id", "selectedFindingId")
    REFERENCES "findings" ("workspaceId", "projectId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "projects_current_spec_same_project_fkey"
    FOREIGN KEY ("workspaceId", "id", "currentSpecVersionId")
    REFERENCES "product_spec_versions" ("workspaceId", "projectId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "evidence_excerpts"
  ADD CONSTRAINT "retained_evidence_spec_same_project_fkey"
    FOREIGN KEY ("workspaceId", "projectId", "retainedBySpecVersionId")
    REFERENCES "product_spec_versions" ("workspaceId", "projectId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE UNIQUE INDEX "one_active_build_per_project"
  ON "workflow_runs" ("workspaceId", "projectId")
  WHERE "kind" IN ('BUILD', 'POLISH')
    AND "status" IN ('QUEUED', 'RUNNING', 'WAITING_FOR_APPROVAL', 'CANCEL_REQUESTED');

CREATE UNIQUE INDEX "one_active_release_per_project"
  ON "workflow_runs" ("workspaceId", "projectId")
  WHERE "kind" IN ('RELEASE', 'ROLLBACK')
    AND "status" IN ('QUEUED', 'RUNNING', 'WAITING_FOR_APPROVAL', 'CANCEL_REQUESTED');

CREATE UNIQUE INDEX "project_secret_grants_projectId_approvalId_secretVersionId_key"
  ON "project_secret_grants" ("projectId", "approvalId", "secretVersionId");

CREATE UNIQUE INDEX "one_last_known_good_deployment_per_project"
  ON "deployments" ("workspaceId", "projectId")
  WHERE "lastKnownGood" = TRUE;
