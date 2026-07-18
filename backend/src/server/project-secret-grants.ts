import "server-only";

import { createHash } from "node:crypto";

import type { Prisma } from "@prisma/client";

import { SecretGrantApprovalPayloadSchema } from "@/contracts";
import { assertProjectRuntimeSecretNameAllowed } from "@/policy/secret-guard";

import { getDb } from "./db";
import { createCanonicalApprovalRecord } from "./security/approval";
import { canonicalJson } from "./security/canonical-json";
import { verifySignedVerificationReport } from "./security/verification-signature";

function serializeApproval(record: {
  id: string;
  projectId: string;
  status: string;
  optimisticVersion: number;
  payload: Prisma.JsonValue;
  payloadHash: string;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: record.id,
    projectId: record.projectId,
    kind: "secret_grant" as const,
    status: record.status.toLowerCase(),
    optimisticVersion: record.optimisticVersion,
    payload: record.payload,
    payloadHash: record.payloadHash,
    expiresAt: record.expiresAt.toISOString(),
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

function grantRequestFingerprint(input: {
  projectId: string;
  artifactId: string;
  secretVersionIds: string[];
  costCeilingMicros: number;
  expiresAt: Date;
}) {
  return createHash("sha256")
    .update(canonicalJson({
      projectId: input.projectId,
      artifactId: input.artifactId,
      secretVersionIds: [...input.secretVersionIds].sort(),
      costCeilingMicros: input.costCeilingMicros,
      expiresAt: input.expiresAt.toISOString(),
    }))
    .digest("hex");
}

function grantApprovalIdFromEvent(
  event: { eventType: string; payload: unknown },
  expectedFingerprint: string,
) {
  if (event.eventType !== "project.secret_grant.proposed" || typeof event.payload !== "object" || event.payload === null) {
    throw new Error("The idempotency key was already used for a different mutation.");
  }
  const payload = event.payload as Record<string, unknown>;
  if (typeof payload.approvalId !== "string" || payload.requestFingerprint !== expectedFingerprint) {
    throw new Error("The idempotency key was already used for different secret grant input.");
  }
  return payload.approvalId;
}

function grantOutboxData(input: {
  workspaceId: string;
  approvalId: string;
  requestFingerprint: string;
  idempotencyKey: string;
}) {
  const payload = { approvalId: input.approvalId, requestFingerprint: input.requestFingerprint };
  return {
    workspaceId: input.workspaceId,
    aggregateType: "secret_grant_request",
    aggregateId: createHash("sha256").update(input.idempotencyKey).digest("hex"),
    aggregateVersion: 1,
    eventType: "project.secret_grant.proposed",
    payload,
    payloadHash: createHash("sha256").update(canonicalJson(payload)).digest("hex"),
    idempotencyKey: input.idempotencyKey,
    publishedAt: new Date(),
  };
}

export async function createProjectSecretGrantProposal(input: {
  workspaceId: string;
  projectId: string;
  artifactId: string;
  secretVersionIds: string[];
  expectedProjectVersion: number;
  costCeilingMicros: number;
  expiresAt: Date;
  actorUserId: string;
  requestId: string;
  idempotencyKey: string;
}) {
  const secretVersionIds = [...new Set(input.secretVersionIds)];
  if (secretVersionIds.length !== input.secretVersionIds.length) throw new Error("Secret versions must be unique.");
  const db = getDb();
  const requestFingerprint = grantRequestFingerprint({ ...input, secretVersionIds });
  const replayEvent = await db.outboxEvent.findUnique({
    where: { workspaceId_idempotencyKey: { workspaceId: input.workspaceId, idempotencyKey: input.idempotencyKey } },
    select: { eventType: true, payload: true },
  });
  if (replayEvent) {
    const approvalId = grantApprovalIdFromEvent(replayEvent, requestFingerprint);
    const approval = await db.approval.findUnique({ where: { id: approvalId } });
    if (!approval || approval.workspaceId !== input.workspaceId || approval.projectId !== input.projectId) throw new Error("Stored secret grant idempotency metadata is invalid.");
    const payload = SecretGrantApprovalPayloadSchema.parse(approval.payload);
    return { approval: serializeApproval(approval), secretGrants: payload.secretGrants, replayed: true };
  }
  return db.$transaction(
    async (tx) => {
      const transactionReplay = await tx.outboxEvent.findUnique({
        where: { workspaceId_idempotencyKey: { workspaceId: input.workspaceId, idempotencyKey: input.idempotencyKey } },
        select: { eventType: true, payload: true },
      });
      if (transactionReplay) {
        const approvalId = grantApprovalIdFromEvent(transactionReplay, requestFingerprint);
        const approval = await tx.approval.findUnique({ where: { id: approvalId } });
        if (!approval || approval.workspaceId !== input.workspaceId || approval.projectId !== input.projectId) throw new Error("Stored secret grant idempotency metadata is invalid.");
        const payload = SecretGrantApprovalPayloadSchema.parse(approval.payload);
        return { approval: serializeApproval(approval), secretGrants: payload.secretGrants, replayed: true };
      }
      const project = await tx.project.findUnique({
        where: { workspaceId_id: { workspaceId: input.workspaceId, id: input.projectId } },
        select: { id: true, optimisticVersion: true },
      });
      if (!project) throw new Error("Project not found.");
      if (project.optimisticVersion !== input.expectedProjectVersion) throw new Error("Project version conflict.");

      const artifact = await tx.buildArtifact.findUnique({
        where: {
          workspaceId_projectId_id: {
            workspaceId: input.workspaceId,
            projectId: input.projectId,
            id: input.artifactId,
          },
        },
        include: { verification: true },
      });
      if (!artifact || artifact.kind !== "VERCEL_OUTPUT" || artifact.verification?.status !== "PASSED") {
        throw new Error("A passed verification artifact is required for a secret grant proposal.");
      }
      const signedArtifactHash = artifact.verification.report && typeof artifact.verification.report === "object" && !Array.isArray(artifact.verification.report)
        ? (artifact.verification.report as Record<string, unknown>).artifactHash
        : null;
      if (
        signedArtifactHash !== artifact.artifactHash ||
        !verifySignedVerificationReport({
          report: artifact.verification.report,
          reportHash: artifact.verification.reportHash,
          signature: artifact.verification.signature,
          key: process.env.VERIFICATION_SIGNING_KEY ?? process.env.BETTER_AUTH_SECRET,
        })
      ) {
        throw new Error("The artifact verification report is invalid or no longer matches the artifact.");
      }
      const now = new Date();
      if ((artifact.expiresAt && artifact.expiresAt <= now) || (artifact.verification.expiresAt && artifact.verification.expiresAt <= now)) {
        throw new Error("The verified artifact has expired.");
      }

      const secrets = await tx.secretVersion.findMany({
        where: {
          id: { in: secretVersionIds },
          workspaceId: input.workspaceId,
          projectId: input.projectId,
          scope: "PROJECT_RUNTIME",
          revokedAt: null,
        },
        select: { id: true, name: true, version: true },
        orderBy: [{ name: "asc" }, { version: "asc" }],
      });
      if (secrets.length !== secretVersionIds.length) {
        throw new Error("One or more project secret versions are missing, revoked, or outside this project.");
      }
      if (new Set(secrets.map((secret) => secret.name)).size !== secrets.length) {
        throw new Error("Choose only one exact version for each secret name.");
      }
      secrets.forEach((secret) => assertProjectRuntimeSecretNameAllowed(secret.name));

      const vercelConnection = await tx.providerConnection.findUnique({
        where: { workspaceId_provider: { workspaceId: input.workspaceId, provider: "VERCEL" } },
        select: { id: true, accountExternalId: true, health: true },
      });
      if (!vercelConnection || vercelConnection.health !== "HEALTHY") {
        throw new Error("A healthy Vercel connection is required for a runtime secret grant proposal.");
      }
      const payload = SecretGrantApprovalPayloadSchema.parse({
        kind: "secret_grant",
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        projectOptimisticVersion: project.optimisticVersion,
        providerAccounts: [{ provider: "vercel", accountId: vercelConnection.accountExternalId ?? vercelConnection.id }],
        costCeilingMicros: input.costCeilingMicros,
        expiresAt: input.expiresAt.toISOString(),
        artifactId: artifact.id,
        artifactHash: artifact.artifactHash,
        verificationReportId: artifact.verification.id,
        verificationReportHash: artifact.verification.reportHash,
        secretGrants: secrets.map((secret) => ({
          secretVersionId: secret.id,
          name: secret.name,
          version: secret.version,
        })),
      });
      const canonical = createCanonicalApprovalRecord(payload);
      const existing = await tx.approval.findUnique({
        where: {
          workspaceId_projectId_payloadHash: {
            workspaceId: input.workspaceId,
            projectId: input.projectId,
            payloadHash: canonical.payloadHash,
          },
        },
      });
      if (existing) {
        await tx.outboxEvent.create({
          data: grantOutboxData({
            workspaceId: input.workspaceId,
            approvalId: existing.id,
            requestFingerprint,
            idempotencyKey: input.idempotencyKey,
          }),
        });
        return { approval: serializeApproval(existing), secretGrants: payload.secretGrants, replayed: true };
      }

      const approval = await tx.approval.create({
        data: {
          workspaceId: input.workspaceId,
          projectId: input.projectId,
          kind: "SECRET_GRANT",
          status: "PENDING",
          payload: canonical.payload as Prisma.InputJsonValue,
          payloadCanonical: canonical.payloadCanonical,
          payloadHash: canonical.payloadHash,
          artifactId: artifact.id,
          upstreamArtifactId: artifact.id,
          expiresAt: input.expiresAt,
        },
      });
      await tx.projectSecretGrant.createMany({
        data: secrets.map((secret) => ({
          workspaceId: input.workspaceId,
          projectId: input.projectId,
          secretVersionId: secret.id,
          approvalId: approval.id,
          status: "PENDING",
        })),
      });
      await tx.outboxEvent.create({
        data: grantOutboxData({
          workspaceId: input.workspaceId,
          approvalId: approval.id,
          requestFingerprint,
          idempotencyKey: input.idempotencyKey,
        }),
      });
      await tx.auditEvent.create({
        data: {
          workspaceId: input.workspaceId,
          actorUserId: input.actorUserId,
          action: "project.secret_grant.proposed",
          targetType: "approval",
          targetId: approval.id,
          requestId: input.requestId,
          metadata: {
            projectId: input.projectId,
            artifactId: artifact.id,
            secretGrants: payload.secretGrants,
            payloadHash: approval.payloadHash,
          } as Prisma.InputJsonValue,
          expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60_000),
        },
      });
      return { approval: serializeApproval(approval), secretGrants: payload.secretGrants, replayed: false };
    },
    { isolationLevel: "Serializable", timeout: 20_000 },
  );
}
