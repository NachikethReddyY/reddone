import "server-only";

import { createHash } from "node:crypto";

import type { Prisma } from "@prisma/client";
import { z } from "zod";

import { ApprovalPayloadSchema } from "@/contracts";
import {
  assertResourceOwnershipMarker,
  collisionResistantResourceName,
} from "@/policy/resource-ownership";
import { dispatchProductionRun } from "@/workflows/production-run";

import { getDb } from "./db";
import { assertWorkspaceBudgetAvailable } from "./budget";
import { reserveCredits } from "./credits";
import { isCustomerCreditsEnforced } from "./env";
import { canonicalizeApprovalPayload, createCanonicalApprovalRecord, verifyApprovalPayloadHash } from "./security/approval";
import { withSerializableTransaction } from "./transactions";
import { canonicalJson } from "./security/canonical-json";
import { verifySignedVerificationReport } from "./security/verification-signature";

const signedArtifactReportSchema = z.object({
  sourceArtifactHash: z.string().regex(/^[a-f0-9]{64}$/),
  artifactHash: z.string().regex(/^[a-f0-9]{64}$/),
  previewArtifactHash: z.string().regex(/^[a-f0-9]{64}$/),
}).passthrough();

async function assertExactApprovalState(
  tx: Prisma.TransactionClient,
  approval: { projectId: string; specVersionId: string | null; artifactId: string | null; upstreamArtifactId: string | null },
  payload: ReturnType<typeof ApprovalPayloadSchema.parse>,
) {
  let signedArtifactReport: z.infer<typeof signedArtifactReportSchema> | null = null;
  const project = await tx.project.findFirst({
    where: { id: approval.projectId, workspaceId: payload.workspaceId },
  });
  if (!project || project.optimisticVersion !== payload.projectOptimisticVersion) {
    throw new Error("Approval is stale because the project version changed.");
  }

  const connections = await tx.providerConnection.findMany({
    where: { workspaceId: payload.workspaceId, health: "HEALTHY" },
  });
  for (const expected of payload.providerAccounts) {
    const actual = connections.find((connection) => connection.provider.toLowerCase() === expected.provider);
    if (!actual || (actual.accountExternalId ?? actual.id) !== expected.accountId) {
      throw new Error(`Approval is stale because the ${expected.provider} account changed or is unhealthy.`);
    }
  }

  if ("specVersionId" in payload) {
    const spec = await tx.productSpecVersion.findFirst({
      where: { id: payload.specVersionId, workspaceId: payload.workspaceId, projectId: payload.projectId },
    });
    if (
      !spec ||
      approval.specVersionId !== spec.id ||
      project.currentSpecVersionId !== spec.id ||
      spec.version !== payload.specVersion ||
      spec.optimisticVersion !== payload.specOptimisticVersion ||
      spec.contentHash !== payload.specHash
    ) {
      throw new Error("Approval is stale because the specification changed.");
    }
    if (payload.kind === "specification_build" && spec.status !== "PENDING_APPROVAL") {
      throw new Error("Approval is stale because the specification is no longer awaiting build approval.");
    }
    if (payload.kind === "first_release" && spec.status !== "APPROVED") {
      throw new Error("Approval is stale because the first-release specification is not approved.");
    }
    if (payload.kind === "polish_release" && spec.status !== "PENDING_APPROVAL") {
      throw new Error("Approval is stale because the polish specification is no longer pending release review.");
    }
  }

  if (payload.kind === "first_release" || payload.kind === "polish_release" || payload.kind === "secret_grant") {
    const artifact = await tx.buildArtifact.findFirst({
      where: { id: payload.artifactId, workspaceId: payload.workspaceId, projectId: payload.projectId },
      include: { verification: true },
    });
    const report = artifact?.verification;
    const parsedReport = signedArtifactReportSchema.safeParse(report?.report);
    const signingKey = process.env.VERIFICATION_SIGNING_KEY ?? process.env.BETTER_AUTH_SECRET;
    if (
      !artifact ||
      approval.artifactId !== artifact.id ||
      artifact.artifactHash !== payload.artifactHash ||
      !report ||
      report.id !== payload.verificationReportId ||
      report.status !== "PASSED" ||
      report.reportHash !== payload.verificationReportHash ||
      !parsedReport.success ||
      parsedReport.data.artifactHash !== artifact.artifactHash ||
      !verifySignedVerificationReport({ report: report.report, reportHash: report.reportHash, signature: report.signature, key: signingKey })
    ) {
      throw new Error("Approval is stale because the artifact or signed verification report changed.");
    }
    signedArtifactReport = parsedReport.data;
  }

  if (payload.kind === "first_release" || payload.kind === "polish_release") {
    assertResourceOwnershipMarker({
      marker: payload.repository.ownershipMarker,
      provider: "github",
      workspaceId: payload.workspaceId,
      projectId: payload.projectId,
    });
    assertResourceOwnershipMarker({
      marker: payload.deployment.ownershipMarker,
      provider: "vercel",
      workspaceId: payload.workspaceId,
      projectId: payload.projectId,
    });
    if (payload.deployment.projectId !== collisionResistantResourceName(project.slug, payload.deployment.ownershipMarker)) {
      throw new Error("Approval is stale because the Vercel project name is not bound to this project.");
    }
    const sourceArtifact = await tx.buildArtifact.findFirst({
      where: {
        id: payload.sourceArtifactId,
        workspaceId: payload.workspaceId,
        projectId: payload.projectId,
        kind: "VERIFIED_SOURCE",
      },
    });
    if (
      !sourceArtifact
      || approval.upstreamArtifactId !== sourceArtifact.id
      || sourceArtifact.artifactHash !== payload.sourceArtifactHash
      || signedArtifactReport?.sourceArtifactHash !== sourceArtifact.artifactHash
    ) {
      throw new Error("Approval is stale because the verified source artifact changed.");
    }
    const repository = await tx.repositoryBinding.findUnique({ where: { projectId: payload.projectId } });
    if (repository) {
      if (
        repository.optimisticVersion !== payload.repository.optimisticVersion ||
        repository.installationId !== payload.repository.installationId ||
        repository.owner !== payload.repository.owner ||
        repository.name !== payload.repository.name ||
        repository.externalRepositoryId !== payload.repository.externalRepositoryId ||
        repository.visibility !== "private"
      ) {
        throw new Error("Approval is stale because the repository binding changed.");
      }
    } else if (payload.repository.optimisticVersion !== 0 || payload.repository.externalRepositoryId !== null) {
      throw new Error("Approval is stale because the repository binding is missing.");
    } else if (payload.repository.name !== collisionResistantResourceName(project.slug, payload.repository.ownershipMarker)) {
      throw new Error("Approval is stale because the GitHub repository name is not collision-resistant.");
    }

    const latestDeployment = await tx.deployment.findFirst({
      where: { workspaceId: payload.workspaceId, projectId: payload.projectId },
      orderBy: { createdAt: "desc" },
    });
    if ((latestDeployment?.optimisticVersion ?? 0) !== payload.deployment.optimisticVersion) {
      throw new Error("Approval is stale because the deployment target changed.");
    }
    if ((latestDeployment?.externalProjectId ?? null) !== payload.deployment.externalProjectId) {
      throw new Error("Approval is stale because the Vercel project binding changed.");
    }
    for (const grant of payload.secretGrants) {
      const authorized = await tx.projectSecretGrant.findFirst({
        where: {
          workspaceId: payload.workspaceId,
          projectId: payload.projectId,
          secretVersionId: grant.secretVersionId,
          status: "ACTIVE",
        },
        include: { secretVersion: true, approval: true },
      });
      if (
        !authorized ||
        authorized.approval.status !== "APPROVED" ||
        authorized.approval.artifactId !== payload.artifactId ||
        authorized.secretVersion.revokedAt ||
        authorized.secretVersion.name !== grant.name ||
        authorized.secretVersion.version !== grant.version
      ) {
        throw new Error(`Approval is stale because secret grant ${grant.name} v${grant.version} is unavailable.`);
      }
    }
    if (payload.kind === "polish_release") {
      const previous = await tx.deployment.findFirst({
        where: { id: payload.previousDeploymentId, workspaceId: payload.workspaceId, projectId: payload.projectId, lastKnownGood: true },
      });
      if (!previous || previous.artifactHash !== payload.previousArtifactHash) {
        throw new Error("Approval is stale because the last-known-good deployment changed.");
      }
    }
  }

  if (payload.kind === "rollback") {
    const [current, target] = await Promise.all([
      tx.deployment.findFirst({ where: { id: payload.deploymentId, workspaceId: payload.workspaceId, projectId: payload.projectId } }),
      tx.deployment.findFirst({ where: { id: payload.targetDeploymentId, workspaceId: payload.workspaceId, projectId: payload.projectId } }),
    ]);
    if (
      !current ||
      current.optimisticVersion !== payload.deploymentOptimisticVersion ||
      !target ||
      target.artifactHash !== payload.targetArtifactHash
    ) {
      throw new Error("Approval is stale because the rollback target changed.");
    }
  }
}

export async function listWorkspaceApprovals(workspaceId: string, projectId?: string) {
  const records = await getDb().approval.findMany({
    where: { workspaceId, ...(projectId ? { projectId } : {}) },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  return records.map((record) => ({
    id: record.id,
    projectId: record.projectId,
    kind: record.kind.toLowerCase(),
    status: record.status.toLowerCase(),
    payload: record.payload,
    payloadHash: record.payloadHash,
    optimisticVersion: record.optimisticVersion,
    decisionReason: record.decisionReason,
    decidedAt: record.decidedAt?.toISOString() ?? null,
    consumedAt: record.consumedAt?.toISOString() ?? null,
    expiresAt: record.expiresAt.toISOString(),
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  }));
}

export async function resolveProductionApproval(input: {
  workspaceId: string;
  userId: string;
  approvalId: string;
  expectedVersion: number;
  payloadHash: string;
  decision: "approved" | "rejected";
  reason?: string;
  idempotencyKey: string;
}) {
  const db = getDb();
  const previouslyResolved = await db.approval.findFirst({
    where: { id: input.approvalId, workspaceId: input.workspaceId },
  });
  if (previouslyResolved && previouslyResolved.status !== "PENDING") {
    const samePayload = previouslyResolved.payloadHash === input.payloadHash;
    const sameDecision =
      (input.decision === "approved" && (previouslyResolved.status === "APPROVED" || previouslyResolved.status === "CONSUMED")) ||
      (input.decision === "rejected" && previouslyResolved.status === "REJECTED" && previouslyResolved.decisionReason === input.reason);
    if (!samePayload || !sameDecision) throw new Error("Approval has already been resolved with a different request.");
    const replayedRun = await db.workflowRun.findUnique({
      where: { workspaceId_idempotencyKey: { workspaceId: input.workspaceId, idempotencyKey: input.idempotencyKey } },
    });
    const executorRunId = replayedRun ? await dispatchProductionRun(input.workspaceId, replayedRun.id) : null;
    return { approval: previouslyResolved, run: replayedRun, executorRunId, replayed: true };
  }
  const result = await withSerializableTransaction(
    db,
    async (tx) => {
      const approval = await tx.approval.findFirst({
        where: { id: input.approvalId, workspaceId: input.workspaceId },
      });
      if (!approval) throw new Error("Approval not found.");
      if (approval.optimisticVersion !== input.expectedVersion) throw new Error("Approval version conflict.");
      if (approval.status !== "PENDING") throw new Error("Approval has already been resolved.");
      if (approval.expiresAt <= new Date()) {
        await tx.approval.update({
          where: { id: approval.id },
          data: { status: "EXPIRED", optimisticVersion: { increment: 1 } },
        });
        throw new Error("Approval has expired.");
      }
      const payload = ApprovalPayloadSchema.parse(approval.payload);
      if (approval.payloadHash !== input.payloadHash || !verifyApprovalPayloadHash(payload, input.payloadHash)) {
        throw new Error("Approval payload integrity check failed.");
      }
      if (approval.payloadCanonical !== canonicalizeApprovalPayload(payload)) {
        throw new Error("Approval canonical payload mismatch.");
      }
      await assertExactApprovalState(tx, approval, payload);
      if (input.decision === "rejected") {
        if (!input.reason) throw new Error("A rejection reason is required.");
        const rejected = await tx.approval.update({
          where: { id: approval.id },
          data: {
            status: "REJECTED",
            decidedByUserId: input.userId,
            decisionReason: input.reason,
            decidedAt: new Date(),
            optimisticVersion: { increment: 1 },
          },
        });
        if ((approval.kind === "SPECIFICATION_BUILD" || approval.kind === "POLISH_RELEASE") && approval.specVersionId) {
          await tx.productSpecVersion.updateMany({
            where: {
              id: approval.specVersionId,
              workspaceId: input.workspaceId,
              projectId: approval.projectId,
              status: "PENDING_APPROVAL",
            },
            data: { status: "REJECTED", optimisticVersion: { increment: 1 } },
          });
        }
        if (approval.kind === "SECRET_GRANT") {
          await tx.projectSecretGrant.updateMany({
            where: { workspaceId: input.workspaceId, projectId: approval.projectId, approvalId: approval.id, status: "PENDING" },
            data: { status: "REVOKED", revokedAt: new Date() },
          });
        }
        const lastKnownGood = await tx.deployment.findFirst({
          where: { workspaceId: input.workspaceId, projectId: approval.projectId, lastKnownGood: true },
          select: { id: true },
        });
        const pendingRelease = await tx.approval.findFirst({
          where: {
            workspaceId: input.workspaceId,
            projectId: approval.projectId,
            kind: { in: ["FIRST_RELEASE", "POLISH_RELEASE"] },
            status: "PENDING",
          },
          select: { id: true },
        });
        await tx.project.update({
          where: { id: approval.projectId },
          data: {
            status: approval.kind === "SPECIFICATION_BUILD"
              ? "AWAITING_SPEC_APPROVAL"
              : pendingRelease
                ? "AWAITING_RELEASE_APPROVAL"
              : lastKnownGood
                ? "RELEASED"
                : "READY_TO_BUILD",
            currentBlocker: `Approval rejected; revise ${approval.kind === "SPECIFICATION_BUILD" || approval.kind === "POLISH_RELEASE" ? "the specification" : approval.kind === "SECRET_GRANT" ? "the exact secret grant" : "the verified artifact"}`,
            optimisticVersion: { increment: 1 },
          },
        });
        return { approval: rejected, run: null };
      }
      if (approval.kind === "SPECIFICATION_BUILD") {
        if (!approval.specVersionId) throw new Error("Specification approval is missing its version.");
        const approved = await tx.approval.update({
          where: { id: approval.id },
          data: {
            status: "APPROVED",
            decidedByUserId: input.userId,
            decidedAt: new Date(),
            optimisticVersion: { increment: 1 },
          },
        });
        await tx.productSpecVersion.update({
          where: { id: approval.specVersionId },
          data: { status: "APPROVED", approvedAt: new Date(), optimisticVersion: { increment: 1 } },
        });
        await tx.project.update({
          where: { id: approval.projectId },
          data: { status: "READY_TO_BUILD", currentBlocker: null, optimisticVersion: { increment: 1 } },
        });
        return { approval: approved, run: null };
      }
      if (approval.kind === "SECRET_GRANT") {
        const approved = await tx.approval.update({
          where: { id: approval.id },
          data: {
            status: "APPROVED",
            decidedByUserId: input.userId,
            decidedAt: new Date(),
            optimisticVersion: { increment: 1 },
          },
        });
        await tx.projectSecretGrant.updateMany({
          where: { workspaceId: input.workspaceId, projectId: approval.projectId, approvalId: approval.id, status: "PENDING" },
          data: { status: "ACTIVE", grantedAt: new Date() },
        });
        const grantPayload = ApprovalPayloadSchema.parse(approval.payload);
        if (grantPayload.kind !== "secret_grant") throw new Error("Secret grant approval payload is invalid.");
        const pendingRelease = await tx.approval.findFirst({
          where: {
            workspaceId: input.workspaceId,
            projectId: approval.projectId,
            artifactId: grantPayload.artifactId,
            kind: { in: ["FIRST_RELEASE", "POLISH_RELEASE"] },
            status: "PENDING",
          },
          orderBy: { createdAt: "desc" },
        });
        let releaseApproval: { id: string; payloadHash: string } | null = null;
        if (pendingRelease) {
          const releasePayload = ApprovalPayloadSchema.parse(pendingRelease.payload);
          if (releasePayload.kind !== "first_release" && releasePayload.kind !== "polish_release") {
            throw new Error("Pending release approval payload is invalid.");
          }
          const merged = createCanonicalApprovalRecord({
            ...releasePayload,
            secretGrants: [...new Map(
              [...releasePayload.secretGrants, ...grantPayload.secretGrants]
                .map((grant) => [`${grant.name}:${grant.version}`, grant] as const),
            ).values()],
            expiresAt: new Date(Date.now() + 48 * 60 * 60_000).toISOString(),
          });
          await tx.approval.update({
            where: { id: pendingRelease.id },
            data: { status: "SUPERSEDED", optimisticVersion: { increment: 1 } },
          });
          releaseApproval = await tx.approval.create({
            data: {
              workspaceId: pendingRelease.workspaceId,
              projectId: pendingRelease.projectId,
              kind: pendingRelease.kind,
              payload: merged.payload,
              payloadCanonical: merged.payloadCanonical,
              payloadHash: merged.payloadHash,
              specVersionId: pendingRelease.specVersionId,
              artifactId: pendingRelease.artifactId,
              upstreamArtifactId: pendingRelease.upstreamArtifactId,
              expiresAt: new Date(merged.payload.expiresAt),
            },
            select: { id: true, payloadHash: true },
          });
        }
        return { approval: approved, run: null, releaseApproval };
      }
      if (approval.kind !== "FIRST_RELEASE" && approval.kind !== "POLISH_RELEASE" && approval.kind !== "ROLLBACK") {
        throw new Error("This approval kind is not executable from this endpoint.");
      }
      if (approval.kind === "POLISH_RELEASE") {
        if (!approval.specVersionId) throw new Error("Polish approval is missing its proposed specification.");
        await tx.productSpecVersion.updateMany({
          where: {
            workspaceId: input.workspaceId,
            projectId: approval.projectId,
            status: "APPROVED",
            id: { not: approval.specVersionId },
          },
          data: { status: "SUPERSEDED", supersededAt: new Date(), optimisticVersion: { increment: 1 } },
        });
        const promotedSpec = await tx.productSpecVersion.updateMany({
          where: {
            id: approval.specVersionId,
            workspaceId: input.workspaceId,
            projectId: approval.projectId,
            status: "PENDING_APPROVAL",
          },
          data: { status: "APPROVED", approvedAt: new Date(), optimisticVersion: { increment: 1 } },
        });
        if (promotedSpec.count !== 1) throw new Error("The polish specification changed before release approval was consumed.");
      }
      const resourceKey = `release:${approval.projectId}`;
      const currentLease = await tx.runLease.findUnique({
        where: { workspaceId_resourceKey: { workspaceId: input.workspaceId, resourceKey } },
      });
      if (currentLease && !currentLease.releasedAt && currentLease.expiresAt > new Date()) {
        throw new Error("A release already holds this project lease.");
      }
      const workspace = await tx.workspace.findUniqueOrThrow({
        where: { id: input.workspaceId },
        select: { monthlyBudgetMicros: true },
      });
      await assertWorkspaceBudgetAvailable(tx, {
        workspaceId: input.workspaceId,
        monthlyBudgetMicros: workspace.monthlyBudgetMicros,
        requestedMicros: BigInt(payload.costCeilingMicros),
      });
      const run = await tx.workflowRun.create({
        data: {
          workspaceId: input.workspaceId,
          projectId: approval.projectId,
          specVersionId: approval.specVersionId,
          kind: approval.kind === "ROLLBACK" ? "ROLLBACK" : "RELEASE",
          status: "QUEUED",
          idempotencyKey: input.idempotencyKey,
          budgetCeilingMicros: BigInt(payload.costCeilingMicros),
          reservedMicros: BigInt(payload.costCeilingMicros),
          steps: {
            create: (approval.kind === "ROLLBACK"
              ? [
                  ["approval", "Consume exact rollback approval"],
                  ["health", "Verify rollback target health"],
                  ["promote", "Promote last-known-good target"],
                ]
              : [
                  ["approval", "Consume exact release approval"],
                  ["github", "Create/reconcile private repository"],
                  ["vercel", "Upload prebuilt candidate"],
                  ["health", "Verify candidate health"],
                  ["promote", "Promote verified candidate"],
                ]).map(([key, label]) => ({
                  workspaceId: input.workspaceId,
                  projectId: approval.projectId,
                  key: key!,
                  label: label!,
                  ...(key === "approval" ? { status: "SUCCEEDED" as const, startedAt: new Date(), finishedAt: new Date() } : {}),
                })),
          },
        },
      });
      if (isCustomerCreditsEnforced()) {
        await reserveCredits(tx, {
          workspaceId: input.workspaceId,
          projectId: approval.projectId,
          runId: run.id,
          runAttempt: run.attempt,
          operation: approval.kind === "ROLLBACK" ? "rollback" : "release",
        });
      }
      if (currentLease) {
        await tx.runLease.update({
          where: { id: currentLease.id },
          data: {
            projectId: approval.projectId,
            runId: run.id,
            ownerId: run.id,
            fencingToken: { increment: 1 },
            acquiredAt: new Date(),
            expiresAt: new Date(Date.now() + 45 * 60_000),
            releasedAt: null,
          },
        });
      } else {
        await tx.runLease.create({
          data: {
            workspaceId: input.workspaceId,
            projectId: approval.projectId,
            runId: run.id,
            resourceKey,
            ownerId: run.id,
            fencingToken: 1n,
            expiresAt: new Date(Date.now() + 45 * 60_000),
          },
        });
      }
      await tx.budgetReservation.create({
        data: {
          workspaceId: input.workspaceId,
          projectId: approval.projectId,
          runId: run.id,
          provider: "VERCEL",
          idempotencyKey: `${input.idempotencyKey}:budget`,
          reservedMicros: BigInt(payload.costCeilingMicros),
          expiresAt: new Date(Date.now() + 60 * 60_000),
        },
      });
      const consumed = await tx.approval.update({
        where: { id: approval.id },
        data: {
          status: "CONSUMED",
          decidedByUserId: input.userId,
          decidedAt: new Date(),
          consumedAt: new Date(),
          optimisticVersion: { increment: 1 },
        },
      });
      const outboxPayload = { runId: run.id, approvalId: approval.id, workspaceId: input.workspaceId, projectId: approval.projectId };
      await tx.outboxEvent.create({
        data: {
          workspaceId: input.workspaceId,
          aggregateType: "workflow_run",
          aggregateId: run.id,
          aggregateVersion: 1,
          eventType: approval.kind === "ROLLBACK" ? "workflow.rollback.queued" : "workflow.release.queued",
          payload: outboxPayload,
          payloadHash: createHash("sha256").update(canonicalJson(outboxPayload)).digest("hex"),
          idempotencyKey: `${input.idempotencyKey}:outbox`,
        },
      });
      await tx.project.update({
        where: { id: approval.projectId },
        data: { currentBlocker: "Release workflow in progress", optimisticVersion: { increment: 1 } },
      });
      return { approval: consumed, run };
    },
    { timeoutMs: 20_000 },
  );
  const executorRunId = result.run ? await dispatchProductionRun(input.workspaceId, result.run.id) : null;
  return { ...result, executorRunId, replayed: false };
}
