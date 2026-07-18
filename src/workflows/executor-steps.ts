import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { Prisma } from "@prisma/client";
import { ApprovalPayloadSchema, ProjectConfigSchema, ProductSpecSchema, type ApprovalPayload } from "@/contracts";
import { getVerifiedArtifact, putImmutableArtifact } from "@/integrations/artifact-store";
import { publishVerifiedTree, reconcilePrivateRepository } from "@/integrations/github";
import { generateProductSpec, improveProductSpec, synthesizeResearch, type ResearchInputDocument } from "@/integrations/kimi";
import { scrapeRedditSubredditThroughOxylabs } from "@/integrations/oxylabs-reddit";
import {
  createVercelDeploymentMetadata,
  getVercelDeployment,
  reconcileRecentVercelDeployment,
  reconcileVercelProject,
} from "@/integrations/vercel";
import {
  assertDeploymentHealthy,
  deployPrebuiltPreview,
  promoteDeployment,
  reconcileSensitiveRuntimeVariables,
} from "@/integrations/vercel-release";
import { getDb } from "@/server/db";
import { recordAuditEvent } from "@/server/audit";
import {
  getBackendBuildProviderAccounts,
  getBackendDaytonaApiKey,
  getBackendKimiApiKey,
  getBackendRedditResidentialCredentials,
} from "@/server/backend-providers";
import { releaseCreditReservation, settleCreditReservation } from "@/server/credits";
import { isCustomerCreditsEnforced } from "@/server/env";
import { readProjectSecretForRelease, readProviderCredential } from "@/server/secret-vault";
import { createCanonicalApprovalRecord } from "@/server/security/approval";
import { canonicalJson } from "@/server/security/canonical-json";
import { verifySignedVerificationReport } from "@/server/security/verification-signature";
import { failureBackoffUntil } from "@/server/schedule";
import { recordKimiUsage } from "@/server/usage";
import {
  assertResourceOwnershipMarker,
  collisionResistantResourceName,
  resourceOwnershipMarker,
} from "@/policy/resource-ownership";
import { runTwoSandboxBuild } from "./kimi-builder";
import { BUILD_WALL_CLOCK_LIMIT_MS } from "./build-deadline";
import { rankResearchCandidates, researchCandidateFingerprint } from "./research-candidates";
import {
  releaseCurrentRunLease,
  renewCurrentRunLease,
  requireCurrentRunLease,
  type WorkflowFencingToken,
} from "./lease-fencing";
import { redactSecrets } from "@/policy/secret-guard";
import { z } from "zod";

export async function executeRollback(workspaceId: string, runId: string, fencingToken: WorkflowFencingToken) {
  "use step";
  const db = getDb();
  const run = await db.workflowRun.findFirstOrThrow({ where: { id: runId, workspaceId } });
  await checkpointRun(workspaceId, runId, fencingToken, "rollback.load");
  const queued = await db.outboxEvent.findFirstOrThrow({
    where: { workspaceId, aggregateType: "workflow_run", aggregateId: runId },
    orderBy: { createdAt: "desc" },
  });
  const approvalId = (queued.payload as Record<string, unknown>).approvalId;
  if (typeof approvalId !== "string") throw new Error("Rollback outbox is missing its approval.");
  const approval = await db.approval.findFirstOrThrow({ where: { id: approvalId, workspaceId, status: "CONSUMED" } });
  const payload = ApprovalPayloadSchema.parse(approval.payload);
  if (payload.kind !== "rollback") throw new Error("Rollback approval payload is invalid.");
  const [current, target] = await Promise.all([
    db.deployment.findFirst({ where: { id: payload.deploymentId, workspaceId, projectId: run.projectId } }),
    db.deployment.findFirst({ where: { id: payload.targetDeploymentId, workspaceId, projectId: run.projectId } }),
  ]);
  if (!current || !target?.url || target.artifactHash !== payload.targetArtifactHash) {
    throw new Error("Approved rollback target is unavailable or changed.");
  }
  const token = await readProviderCredential({ workspaceId, provider: "vercel" });
  await checkpointRun(workspaceId, runId, fencingToken, "rollback.health");
  await assertDeploymentHealthy(target.url, target.artifactHash);
  await checkpointRun(workspaceId, runId, fencingToken, "rollback.promote");
  await promoteDeployment(
    { token, teamId: target.teamId, projectId: target.externalProjectId, cwd: os.tmpdir() },
    target.url,
  );
  await db.$transaction(async (tx) => {
    await guardRunTransaction(tx, workspaceId, runId, fencingToken, "rollback.finalize");
    await tx.deployment.updateMany({
      where: { workspaceId, projectId: run.projectId, lastKnownGood: true },
      data: { lastKnownGood: false },
    });
    await tx.deployment.update({
      where: { id: current.id },
      data: { status: "ROLLED_BACK", rolledBackAt: new Date(), optimisticVersion: { increment: 1 } },
    });
    await tx.deployment.update({
      where: { id: target.id },
      data: { status: "HEALTHY", lastKnownGood: true, promotedAt: new Date(), optimisticVersion: { increment: 1 } },
    });
    await tx.project.update({
      where: { id: run.projectId },
      data: { status: "RELEASED", currentBlocker: null, optimisticVersion: { increment: 1 } },
    });
    await completeRun(tx, runId, workspaceId, run.projectId, fencingToken, "Last-known-good deployment promoted as an approved rollback.");
  });
  return { runId, status: "succeeded", url: target.url, targetDeploymentId: target.id };
}

const storedArtifactIndexSchema = z.object({
  manifest: z.object({
    artifactSha256: z.string().regex(/^[a-f0-9]{64}$/),
    fileCount: z.number().int().min(1).max(20_000),
    totalBytes: z.number().int().min(0).max(192 * 1024 * 1024),
  }).passthrough(),
  files: z.array(
    z.object({
      path: z.string().min(1).max(1_024),
      key: z.string().startsWith("workspaces/"),
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
      byteSize: z.number().int().nonnegative().max(10 * 1024 * 1024),
    }),
  ).min(1).max(20_000),
});

async function mapConcurrent<T, R>(items: readonly T[], concurrency: number, mapper: (item: T, index: number) => Promise<R>) {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, async () => {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      results[index] = await mapper(items[index]!, index);
    }
  });
  await Promise.all(workers);
  return results;
}

const signedReleaseReportSchema = z.object({
  sourceArtifactHash: z.string().regex(/^[a-f0-9]{64}$/),
  artifactHash: z.string().regex(/^[a-f0-9]{64}$/),
  previewArtifactHash: z.string().regex(/^[a-f0-9]{64}$/),
}).passthrough();

function safeReleasePath(root: string, candidate: string, requiredPrefix?: string) {
  if (!candidate || candidate.startsWith("/") || candidate.includes("\\") || candidate.split("/").includes("..")) {
    throw new Error("Release artifact path traversal was rejected.");
  }
  if (requiredPrefix && !candidate.startsWith(requiredPrefix)) throw new Error("Release artifact path is outside the verified output root.");
  const destination = path.resolve(root, candidate);
  if (!destination.startsWith(`${path.resolve(root)}${path.sep}`)) throw new Error("Release artifact escaped its reconstruction root.");
  return destination;
}

async function loadStoredFiles(objectKey: string, indexHash: string) {
  const indexBytes = await getVerifiedArtifact(objectKey, indexHash);
  const index = storedArtifactIndexSchema.parse(JSON.parse(Buffer.from(indexBytes).toString("utf8")));
  if (index.manifest.fileCount !== index.files.length) throw new Error("Stored release artifact file count mismatch.");
  const uniquePaths = new Set(index.files.map((file) => file.path));
  if (uniquePaths.size !== index.files.length) throw new Error("Stored release artifact contains duplicate paths.");
  const indexedBytes = index.files.reduce((total, file) => total + file.byteSize, 0);
  if (indexedBytes !== index.manifest.totalBytes) throw new Error("Stored release artifact byte count mismatch.");
  const files = await mapConcurrent(index.files, 16, async (file) => {
    const content = await getVerifiedArtifact(file.key, file.sha256, Math.max(1, file.byteSize));
    if (content.byteLength !== file.byteSize) throw new Error("Stored release artifact file size mismatch.");
    return {
      path: file.path,
      content,
    };
  });
  const canonical = index.files
    .map((file) => ({ path: file.path, size: file.byteSize, sha256: file.sha256 }))
    .sort((left, right) => left.path.localeCompare(right.path))
    .map((file) => `${file.path}\0${file.size}\0${file.sha256}`)
    .join("\n");
  if (createHash("sha256").update(canonical).digest("hex") !== index.manifest.artifactSha256) {
    throw new Error("Stored release artifact manifest mismatch.");
  }
  return files;
}

export async function executeRelease(workspaceId: string, runId: string, fencingToken: WorkflowFencingToken) {
  "use step";
  const db = getDb();
  const run = await db.workflowRun.findFirstOrThrow({
    where: { id: runId, workspaceId },
    include: { project: true },
  });
  await checkpointRun(workspaceId, runId, fencingToken, "release.load");
  const queued = await db.outboxEvent.findFirstOrThrow({
    where: { workspaceId, aggregateType: "workflow_run", aggregateId: runId },
    orderBy: { createdAt: "desc" },
  });
  const approvalId = (queued.payload as Record<string, unknown>).approvalId;
  if (typeof approvalId !== "string") throw new Error("Release outbox is missing its approval.");
  const approval = await db.approval.findFirstOrThrow({
    where: { id: approvalId, workspaceId, status: "CONSUMED" },
    include: { artifact: { include: { verification: true } }, upstreamArtifact: true },
  });
  const payload = ApprovalPayloadSchema.parse(approval.payload);
  if ((payload.kind !== "first_release" && payload.kind !== "polish_release") || !approval.artifact || !approval.upstreamArtifact) {
    throw new Error("Release approval does not reference verified source and output artifacts.");
  }
  if (approval.artifact.artifactHash !== payload.artifactHash || approval.artifact.verification?.status !== "PASSED") {
    throw new Error("Release artifact no longer matches its signed verification report.");
  }
  const verification = approval.artifact.verification;
  const signedReport = signedReleaseReportSchema.safeParse(verification?.report);
  if (
    !verification ||
    !signedReport.success ||
    verification.id !== payload.verificationReportId ||
    verification.reportHash !== payload.verificationReportHash ||
    signedReport.data.artifactHash !== approval.artifact.artifactHash ||
    signedReport.data.sourceArtifactHash !== approval.upstreamArtifact.artifactHash ||
    approval.upstreamArtifact.id !== payload.sourceArtifactId ||
    approval.upstreamArtifact.artifactHash !== payload.sourceArtifactHash ||
    !verifySignedVerificationReport({
      report: verification.report,
      reportHash: verification.reportHash,
      signature: verification.signature,
      key: process.env.VERIFICATION_SIGNING_KEY ?? process.env.BETTER_AUTH_SECRET,
    })
  ) {
    throw new Error("Release verification signature is invalid.");
  }
  const [sourceFiles, outputFiles] = await Promise.all([
    loadStoredFiles(approval.upstreamArtifact.objectKey, approval.upstreamArtifact.manifestHash),
    loadStoredFiles(approval.artifact.objectKey, approval.artifact.manifestHash),
  ]);

  await checkpointRun(workspaceId, runId, fencingToken, "release.github.reconcile");
  const appId = process.env.GITHUB_APP_ID;
  const privateKey = process.env.GITHUB_APP_PRIVATE_KEY?.replaceAll("\\n", "\n");
  if (!appId || !privateKey) throw new Error("GitHub App configuration is incomplete.");
  assertResourceOwnershipMarker({
    marker: payload.repository.ownershipMarker,
    provider: "github",
    workspaceId,
    projectId: run.projectId,
  });
  assertResourceOwnershipMarker({
    marker: payload.deployment.ownershipMarker,
    provider: "vercel",
    workspaceId,
    projectId: run.projectId,
  });
  const githubConfig = { appId, privateKey, installationId: payload.repository.installationId };
  const repository = await reconcilePrivateRepository(githubConfig, {
    owner: payload.repository.owner,
    name: payload.repository.name,
    ownershipMarker: payload.repository.ownershipMarker,
    expectedExternalRepositoryId: payload.repository.externalRepositoryId,
  });
  await recordAuditEvent({
    workspaceId,
    action: repository.created ? "github.repository.created" : "github.repository.reconciled",
    targetType: "repository",
    targetId: repository.id,
    metadata: { fullName: repository.fullName, visibility: "private", runId },
  });
  await db.repositoryBinding.upsert({
    where: { projectId: run.projectId },
    create: {
      workspaceId,
      projectId: run.projectId,
      installationId: payload.repository.installationId,
      externalRepositoryId: repository.id,
      owner: payload.repository.owner,
      name: payload.repository.name,
      visibility: "private",
      status: "PENDING",
    },
    update: { externalRepositoryId: repository.id, status: "PENDING" },
  });
  await checkpointRun(workspaceId, runId, fencingToken, "release.github.publish");
  const commit = await publishVerifiedTree(githubConfig, {
    owner: payload.repository.owner,
    repo: payload.repository.name,
    branch: "main",
    files: sourceFiles,
    message: `Release ${approval.artifact.artifactHash.slice(0, 12)}`,
  });
  await recordAuditEvent({
    workspaceId,
    action: "github.verified_source.published",
    targetType: "commit",
    targetId: commit.commitSha,
    metadata: { repository: repository.fullName, artifactHash: approval.upstreamArtifact.artifactHash, runId },
  });
  await db.repositoryBinding.update({
    where: { projectId: run.projectId },
    data: { status: "READY", lastCommitSha: commit.commitSha, optimisticVersion: { increment: 1 } },
  });

  const vercelToken = await readProviderCredential({ workspaceId, provider: "vercel" });
  await checkpointRun(workspaceId, runId, fencingToken, "release.vercel.reconcile");
  const project = await reconcileVercelProject({
    accessToken: vercelToken,
    teamId: payload.deployment.teamId,
    name: payload.deployment.projectId,
    ownershipMarker: payload.deployment.ownershipMarker,
    expectedExternalProjectId: payload.deployment.externalProjectId,
  });
  await recordAuditEvent({
    workspaceId,
    action: project.created ? "vercel.project.created" : "vercel.project.reconciled",
    targetType: "vercel_project",
    targetId: project.id,
    metadata: { teamId: payload.deployment.teamId, gitAutoDeploy: false, runId },
  });
  const approvedRuntimeVariables: { key: string; value: string }[] = [];
  for (const grant of payload.secretGrants) {
    await checkpointRun(workspaceId, runId, fencingToken, `release.secret.${grant.name}`);
    const value = await readProjectSecretForRelease({
      workspaceId,
      projectId: run.projectId,
      releaseRunId: runId,
      secretVersionId: grant.secretVersionId,
      name: grant.name,
      version: grant.version,
    });
    approvedRuntimeVariables.push({ key: grant.name, value });
  }
  await checkpointRun(workspaceId, runId, fencingToken, "release.secret.reconcile");
  const runtimeReconciliation = await reconcileSensitiveRuntimeVariables({
    token: vercelToken,
    teamId: payload.deployment.teamId,
    projectId: project.id,
    target: payload.deployment.environment,
    variables: approvedRuntimeVariables,
  });
  for (const grant of payload.secretGrants) {
    await recordAuditEvent({
      workspaceId,
      action: "vercel.secret_version.granted",
      targetType: "secret_version",
      targetId: grant.secretVersionId,
      metadata: { name: grant.name, version: grant.version, projectId: project.id, runId },
    });
  }
  await recordAuditEvent({
    workspaceId,
    action: "vercel.runtime_secrets.reconciled",
    targetType: "vercel_project",
    targetId: project.id,
    metadata: {
      environment: payload.deployment.environment,
      approved: payload.secretGrants.map((grant) => ({ name: grant.name, version: grant.version })),
      removedManagedKeys: runtimeReconciliation.removedKeys,
      runId,
    },
  });

  const root = await mkdtemp(path.join(os.tmpdir(), "reddone-release-"));
  try {
    for (const file of outputFiles) {
      const destination = safeReleasePath(root, file.path, ".vercel/output/");
      await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      await writeFile(destination, file.content, { mode: 0o600, flag: "wx" });
    }
    const projectConfigPath = safeReleasePath(root, ".vercel/project.json", ".vercel/");
    await mkdir(path.dirname(projectConfigPath), { recursive: true, mode: 0o700 });
    await writeFile(
      projectConfigPath,
      JSON.stringify({ orgId: payload.deployment.teamId, projectId: project.id, projectName: project.name }),
      { mode: 0o600, flag: "wx" },
    );
    const target = { token: vercelToken, teamId: payload.deployment.teamId, projectId: project.id, cwd: root };
    const deploymentMetadata = createVercelDeploymentMetadata({
      runId,
      artifactHash: approval.artifact.artifactHash,
    });
    const pendingExternalDeploymentId = `pending:vercel:${runId}:${approval.artifact.artifactHash}`;
    let deploymentRecord = await db.deployment.findFirst({
      where: { workspaceId, projectId: run.projectId, artifactId: approval.artifact.id },
      orderBy: { createdAt: "desc" },
    });
    if (!deploymentRecord) {
      const lastKnownGood = await db.deployment.findFirst({
        where: { workspaceId, projectId: run.projectId, lastKnownGood: true },
        orderBy: { createdAt: "desc" },
      });
      deploymentRecord = await db.deployment.create({
        data: {
          workspaceId,
          projectId: run.projectId,
          artifactId: approval.artifact.id,
          previousDeploymentId: lastKnownGood?.id ?? null,
          externalProjectId: project.id,
          externalDeploymentId: pendingExternalDeploymentId,
          teamId: payload.deployment.teamId,
          environment: payload.deployment.environment,
          status: "QUEUED",
          artifactHash: approval.artifact.artifactHash,
        },
      });
    }

    if (deploymentRecord.externalDeploymentId === pendingExternalDeploymentId) {
      await checkpointRun(workspaceId, runId, fencingToken, "release.deploy.preview");
      const reconciled = await reconcileRecentVercelDeployment({
        accessToken: vercelToken,
        teamId: payload.deployment.teamId,
        projectId: project.id,
        metadata: deploymentMetadata,
        since: deploymentRecord.createdAt,
      });
      let external: { id: string; url: string };
      if (reconciled) {
        external = reconciled;
      } else {
        if (deploymentRecord.status !== "QUEUED") {
          throw new Error("The previous Vercel upload attempt is still unresolved; duplicate deployment was refused.");
        }
        const uploadClaim = await db.deployment.updateMany({
          where: { id: deploymentRecord.id, externalDeploymentId: pendingExternalDeploymentId, status: "QUEUED" },
          data: { status: "UPLOADING", optimisticVersion: { increment: 1 } },
        });
        if (uploadClaim.count !== 1) throw new Error("The Vercel deployment intent changed before upload.");
        await checkpointRun(workspaceId, runId, fencingToken, "release.deploy.upload");
        const previewUrl = await deployPrebuiltPreview(target, deploymentMetadata);
        const created = await getVercelDeployment({
          accessToken: vercelToken,
          teamId: payload.deployment.teamId,
          url: previewUrl,
        });
        external = { id: created.id, url: previewUrl };
      }

      deploymentRecord = await db.deployment.update({
        where: { id: deploymentRecord.id },
        data: {
          externalDeploymentId: external.id,
          status: "READY_UNPROMOTED",
          url: external.url,
          healthCheckUrl: `${external.url}/api/health`,
          healthFailure: null,
          optimisticVersion: { increment: 1 },
        },
      });
      await recordAuditEvent({
        workspaceId,
        action: reconciled ? "vercel.prebuilt_candidate.reconciled" : "vercel.prebuilt_candidate.created",
        targetType: "deployment",
        targetId: external.id,
        metadata: { artifactHash: approval.artifact.artifactHash, url: external.url, runId },
      });
    }
    if (!deploymentRecord.url) throw new Error("Candidate deployment has no URL.");
    await checkpointRun(workspaceId, runId, fencingToken, "release.health");
    await db.deployment.update({ where: { id: deploymentRecord.id }, data: { status: "HEALTH_CHECKING" } });
    try {
      await assertDeploymentHealthy(deploymentRecord.url, approval.artifact.artifactHash);
    } catch (error) {
      await checkpointRun(workspaceId, runId, fencingToken, "release.health.failure");
      await db.deployment.update({
        where: { id: deploymentRecord.id },
        data: { status: "FAILED", healthFailure: redactSecrets(error instanceof Error ? error.message : "Health check failed.") },
      });
      throw error;
    }
    await checkpointRun(workspaceId, runId, fencingToken, "release.promote");
    await promoteDeployment(target, deploymentRecord.url);
    await recordAuditEvent({
      workspaceId,
      action: "vercel.deployment.promoted",
      targetType: "deployment",
      targetId: deploymentRecord.externalDeploymentId,
      metadata: { url: deploymentRecord.url, artifactHash: approval.artifact.artifactHash, runId },
    });
    await db.$transaction(async (tx) => {
      await guardRunTransaction(tx, workspaceId, runId, fencingToken, "release.finalize");
      await tx.deployment.updateMany({
        where: { workspaceId, projectId: run.projectId, lastKnownGood: true },
        data: { lastKnownGood: false },
      });
      await tx.deployment.update({
        where: { id: deploymentRecord!.id },
        data: { status: "HEALTHY", lastKnownGood: true, promotedAt: new Date(), optimisticVersion: { increment: 1 } },
      });
      if (payload.secretGrants.length > 0) {
        await tx.projectSecretGrant.updateMany({
          where: {
            workspaceId,
            projectId: run.projectId,
            status: "ACTIVE",
            secretVersionId: { in: payload.secretGrants.map((grant) => grant.secretVersionId) },
          },
          data: { deploymentId: deploymentRecord!.id },
        });
      }
      await tx.project.update({
        where: { id: run.projectId },
        data: { status: "RELEASED", currentBlocker: null, optimisticVersion: { increment: 1 } },
      });
      await completeRun(tx, runId, workspaceId, run.projectId, fencingToken, "Private repository and healthy prebuilt deployment released.");
    });
    return { runId, status: "succeeded", repository: repository.fullName, commit: commit.commitSha, url: deploymentRecord.url };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export async function failRun(workspaceId: string, runId: string, fencingToken: WorkflowFencingToken, unsafeMessage: string) {
  "use step";
  const db = getDb();
  const run = await db.workflowRun.findFirst({ where: { id: runId, workspaceId } });
  if (!run || run.status === "CANCEL_REQUESTED" || run.status === "CANCELED" || run.status === "SUCCEEDED") return;
  const message = redactSecrets(unsafeMessage).slice(0, 1_000);
  await db.$transaction(async (tx) => {
    const currentLease = await renewCurrentRunLease((args) => tx.runLease.updateMany(args), {
      workspaceId,
      runId,
      fencingToken,
    });
    if (!currentLease) return;
    const failed = await tx.workflowRun.updateMany({
      where: { id: runId, workspaceId, status: "RUNNING", cancelRequestedAt: null },
      data: { status: "FAILED", failureCode: "workflow_step_failed", failureMessage: message, finishedAt: new Date(), stateVersion: { increment: 1 } },
    });
    if (failed.count !== 1) return;
    await tx.workflowStep.updateMany({
      where: { runId, status: { in: ["PENDING", "RUNNING", "WAITING"] } },
      data: { status: "FAILED", failureCode: "workflow_step_failed", failureMessage: message, finishedAt: new Date() },
    });
    const failedAt = new Date();
    await tx.budgetReservation.updateMany({
      where: { runId, status: { in: ["RESERVED", "EXCEEDED"] } },
      data: { status: "RELEASED", releasedAt: failedAt },
    });
    if (isCustomerCreditsEnforced()) {
      const reservation = await tx.creditReservation.findUnique({
        where: { runId_runAttempt: { runId, runAttempt: run.attempt } },
        select: { id: true, status: true },
      });
      if (reservation?.status === "HELD") {
        await releaseCreditReservation(tx, { workspaceId, reservationId: reservation.id, now: failedAt });
      }
    }
    if (!(await releaseCurrentRunLease((args) => tx.runLease.updateMany(args), { workspaceId, runId, fencingToken }))) {
      throw new Error("Workflow lease changed while recording failure.");
    }
    await tx.project.update({
      where: { id: run.projectId },
      data: { status: "FAILED", currentBlocker: "The latest run failed; the last-known-good release is unchanged", optimisticVersion: { increment: 1 } },
    });
    if (run.scheduleId) {
      const schedule = await tx.schedule.findUnique({ where: { id: run.scheduleId } });
      if (schedule && schedule.status !== "PAUSED") {
        const failures = schedule.consecutiveFailures + 1;
        const scheduleKind = schedule.kind === "HOURLY_RESEARCH" ? "hourly_research" : "five_hour_polish";
        const backoffUntil = failureBackoffUntil(scheduleKind, failures);
        await tx.schedule.update({
          where: { id: schedule.id },
          data: {
            status: "BACKING_OFF",
            consecutiveFailures: failures,
            backoffUntil,
            nextRunAt: backoffUntil,
            lastCompletedAt: new Date(),
            optimisticVersion: { increment: 1 },
          },
        });
      }
    }
    await tx.activityEvent.create({
      data: {
        workspaceId,
        projectId: run.projectId,
        runId,
        type: "workflow.run.failed",
        severity: "ERROR",
        message,
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60_000),
      },
    });
  });
}

export async function claimRun(workspaceId: string, runId: string) {
  "use step";
  const db = getDb();
  return db.$transaction(async (tx) => {
    const found = await tx.workflowRun.findFirst({ where: { id: runId, workspaceId } });
    if (!found) throw new Error("Workflow run not found.");
    if (found.status !== "QUEUED" || found.cancelRequestedAt) return null;
    let researchPurpose: "research" | "specification" = "research";
    let findingId: string | null = null;
    if (found.kind === "RESEARCH") {
      const event = await tx.outboxEvent.findFirst({
        where: { workspaceId, aggregateType: "workflow_run", aggregateId: runId, eventType: "workflow.run.queued" },
        orderBy: { createdAt: "desc" },
        select: { payload: true },
      });
      const payload = event?.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
        ? event.payload as Record<string, unknown>
        : {};
      if (payload.purpose !== undefined && payload.purpose !== "specification") {
        throw new Error("Research workflow intent is invalid.");
      }
      if (payload.purpose === "specification") {
        if (typeof payload.findingId !== "string" || !payload.findingId) {
          throw new Error("Specification workflow intent is missing its selected finding.");
        }
        researchPurpose = "specification";
        findingId = payload.findingId;
      }
    }
    if (isCustomerCreditsEnforced()) {
      const expectedOperation = found.kind === "RESEARCH" ? researchPurpose : found.kind.toLowerCase();
      const reservation = await tx.creditReservation.findUnique({
        where: { runId_runAttempt: { runId, runAttempt: found.attempt } },
      });
      if (
        !reservation
        || reservation.status !== "HELD"
        || reservation.workspaceId !== workspaceId
        || reservation.projectId !== found.projectId
        || reservation.operation.toLowerCase() !== expectedOperation
      ) {
        throw new Error("Workflow run has no valid customer credit reservation.");
      }
    }
    const lease = await tx.runLease.findFirst({
      where: { workspaceId, runId, ownerId: runId, releasedAt: null, expiresAt: { gt: new Date() } },
      select: { fencingToken: true },
    });
    if (!lease) throw new Error("Workflow run has no current executable lease.");
    const fencingToken = lease.fencingToken.toString();
    const claimed = await tx.workflowRun.updateMany({
      where: { id: runId, workspaceId, status: "QUEUED", cancelRequestedAt: null },
      data: { status: "RUNNING", startedAt: found.startedAt ?? new Date(), lastHeartbeatAt: new Date(), stateVersion: { increment: 1 } },
    });
    if (claimed.count !== 1) return null;
    await requireCurrentRunLease(
      (args) => tx.runLease.updateMany(args),
      { workspaceId, runId, fencingToken },
      "Workflow lease changed while its durable attempt was being claimed.",
    );
    await tx.activityEvent.create({
      data: {
        workspaceId,
        projectId: found.projectId,
        runId,
        type: "workflow.run.started",
        severity: "INFO",
        message: `${found.kind.toLowerCase()} workflow started.`,
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60_000),
      },
    });
    return { kind: found.kind, fencingToken, researchPurpose, findingId };
  });
}

function workflowStepForCheckpoint(stepKey: string) {
  if (stepKey === "research.source" || stepKey.startsWith("research.source.")) return "source";
  if (stepKey === "research.kimi.extract") return "extract";
  if (stepKey === "research.kimi.spec") return "spec";
  if (stepKey === "research.selection") return "selection";
  if (stepKey === "research.finalize") return "approval";
  if (stepKey === "research.incremental.store") return "store";
  if (stepKey === "polish.evidence.delta" || stepKey === "polish.spec.generate") return "evidence_delta";
  if (stepKey === "build.sandbox.create" || stepKey === "build.builder") return "builder";
  if (stepKey === "build.verifier") return "verifier";
  if (stepKey === "build.artifact.persist") return "artifact";
  if (stepKey === "build.approval.finalize") return "approval_release";
  if (stepKey === "release.load" || stepKey === "rollback.load") return "approval";
  if (stepKey.startsWith("release.github.")) return "github";
  if (stepKey.startsWith("release.secret.") || stepKey.startsWith("release.vercel.") || stepKey.startsWith("release.deploy.")) return "vercel";
  if (stepKey.startsWith("release.health") || stepKey.startsWith("rollback.health")) return "health";
  if (stepKey === "release.promote" || stepKey === "rollback.promote") return "promote";
  return null;
}

async function checkpointRun(workspaceId: string, runId: string, fencingToken: WorkflowFencingToken, stepKey: string) {
  const db = getDb();
  const safeStepKey = stepKey.slice(0, 100);
  const logicalStep = workflowStepForCheckpoint(safeStepKey);
  await db.$transaction(async (tx) => {
    const updated = await tx.workflowRun.updateMany({
      where: { id: runId, workspaceId, status: "RUNNING", cancelRequestedAt: null },
      data: { currentStepKey: safeStepKey, lastHeartbeatAt: new Date(), stateVersion: { increment: 1 } },
    });
    if (updated.count !== 1) throw new Error("Workflow run was canceled or is no longer executable.");
    await requireCurrentRunLease(
      (args) => tx.runLease.updateMany(args),
      { workspaceId, runId, fencingToken },
      "Workflow lease expired or lost its fencing token.",
    );
    if (logicalStep) {
      await tx.workflowStep.updateMany({
        where: { runId, status: "RUNNING", key: { not: logicalStep } },
        data: { status: "SUCCEEDED", finishedAt: new Date() },
      });
      await tx.workflowStep.updateMany({
        where: { runId, key: logicalStep, status: "PENDING" },
        data: { status: "RUNNING", startedAt: new Date() },
      });
    }
    const eventType = `workflow.checkpoint.${safeStepKey}`.slice(0, 150);
    const existingEvent = await tx.activityEvent.findFirst({ where: { workspaceId, runId, type: eventType }, select: { id: true } });
    if (!existingEvent) {
      const run = await tx.workflowRun.findUniqueOrThrow({ where: { id: runId }, select: { projectId: true } });
      await tx.activityEvent.create({
        data: {
          workspaceId,
          projectId: run.projectId,
          runId,
          type: eventType,
          severity: "INFO",
          message: logicalStep ? `Entered ${logicalStep.replaceAll("_", " ")} step.` : "Workflow checkpoint recorded.",
          expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60_000),
        },
      });
    }
  });
}

async function guardRunTransaction(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  runId: string,
  fencingToken: WorkflowFencingToken,
  stepKey: string,
) {
  const guarded = await tx.workflowRun.updateMany({
    where: { id: runId, workspaceId, status: "RUNNING", cancelRequestedAt: null },
    data: { currentStepKey: stepKey.slice(0, 100), lastHeartbeatAt: new Date(), stateVersion: { increment: 1 } },
  });
  if (guarded.count !== 1) throw new Error("Workflow run was canceled before its final transaction.");
  await requireCurrentRunLease(
    (args) => tx.runLease.updateMany(args),
    { workspaceId, runId, fencingToken },
    "Workflow lease expired before the final transaction.",
  );
}

const fixtureDocuments: ResearchInputDocument[] = [
  {
    id: "fixture-latepay-001",
    title: "Friday invoice follow-up ritual",
    body: "I spend part of every Friday checking invoices and writing the same increasingly awkward reminder messages.",
    score: 91,
  },
  {
    id: "fixture-latepay-002",
    title: "A late invoice can be next month’s payroll",
    body: "The invoice is only two weeks late, but it is half of next month’s payroll and I do not know when to escalate.",
    score: 88,
  },
  {
    id: "fixture-latepay-003",
    title: "Promises are scattered",
    body: "Payment promises live across email and chat, so I reconstruct the history before each reminder.",
    score: 86,
  },
];

export async function executeResearch(workspaceId: string, runId: string, fencingToken: WorkflowFencingToken) {
  "use step";
  const db = getDb();
  const run = await db.workflowRun.findFirstOrThrow({
    where: { id: runId, workspaceId },
    include: { project: { include: { sources: true } } },
  });
  const incrementalResearch = Boolean(run.project.currentSpecVersionId);
  const onKimiUsage = async (sample: Parameters<typeof recordKimiUsage>[0]["sample"]) => {
    const recorded = await recordKimiUsage({ workspaceId, projectId: run.projectId, runId, sample });
    if (recorded.exceeded) throw new Error("The run budget was exceeded; no further provider calls are allowed.");
  };
  await checkpointRun(workspaceId, runId, fencingToken, "research.source");
  const config = ProjectConfigSchema.parse(run.project.config);
  let documents: ResearchInputDocument[] = [];
  if (run.project.researchMode === "FIXTURE") {
    documents = fixtureDocuments;
  } else if (run.project.researchMode === "AUTHORIZED_IMPORT") {
    const stored = await db.researchDocument.findMany({
      where: { workspaceId, projectId: run.projectId, purgedAt: null, rawExpiresAt: { gt: new Date() } },
      take: config.maxDocumentsPerRun,
      orderBy: { createdAt: "desc" },
    });
    documents = stored.map((document) => ({
      id: document.externalId,
      title: document.title,
      body: document.body,
      ...(document.sourcePublishedAt ? { createdAt: document.sourcePublishedAt.toISOString() } : {}),
      ...(document.permalink ? { permalink: document.permalink } : {}),
      attribution: document.attribution,
    }));
  } else {
    const firstSource = config.sourceLabels[0] ?? "r/all";
    const scrapeConfig = config.redditWebScrape ?? {
      subreddit: firstSource.startsWith("r/") ? firstSource.slice(2) : "all",
      ...(firstSource.startsWith("search:") ? { keywords: firstSource.slice("search:".length) } : {}),
      sort: "relevance" as const,
      time: "year" as const,
      agentCount: 4,
    };
    await checkpointRun(workspaceId, runId, fencingToken, "research.source.oxylabs");
    const collected = await scrapeRedditSubredditThroughOxylabs({
      credentials: getBackendRedditResidentialCredentials(),
      config: scrapeConfig,
      maxDocuments: config.maxDocumentsPerRun,
    });
    documents = collected.documents.map((document) => ({
      id: document.id,
      title: document.title,
      body: document.body,
      score: document.score,
      createdAt: document.createdAt,
      permalink: document.permalink,
      attribution: document.attribution,
    }));
    await recordAuditEvent({
      workspaceId,
      action: "reddit.oxylabs_collection.completed",
      targetType: "workflow_run",
      targetId: runId,
      metadata: {
        subreddit: `r/${scrapeConfig.subreddit}`,
        sort: scrapeConfig.sort,
        time: scrapeConfig.time,
        keywordSearch: Boolean(scrapeConfig.keywords),
        pagesFetched: collected.pagesFetched,
        documents: documents.length,
        agents: collected.agents,
      },
    });
  }
  documents = [...new Map(documents.map((document) => [document.id, document])).values()]
    .slice(0, config.maxDocumentsPerRun);
  if (incrementalResearch && documents.length > 0) {
    const existingEvidence = await db.evidenceExcerpt.findMany({
      where: { workspaceId, projectId: run.projectId },
      select: { sourceExternalId: true, contentHash: true },
    });
    const existingKeys = new Set(existingEvidence.map((item) => `${item.sourceExternalId}:${item.contentHash}`));
    documents = documents.filter((document) => {
      const excerptHash = createHash("sha256").update(document.body.slice(0, 1_200)).digest("hex");
      return !existingKeys.has(`${document.id}:${excerptHash}`);
    });
  }
  if (documents.length === 0) {
    if (!incrementalResearch) throw new Error("No authorized research documents are available.");
    await checkpointRun(workspaceId, runId, fencingToken, "research.incremental.store");
    await db.$transaction(async (tx) => {
      await guardRunTransaction(tx, workspaceId, runId, fencingToken, "research.incremental.store");
      await completeRun(tx, runId, workspaceId, run.projectId, fencingToken, "Incremental research found no new attributable evidence.");
    });
    return { runId, status: "succeeded", incremental: true, evidenceCount: 0 };
  }
  const kimiKey = await getBackendKimiApiKey(workspaceId);
  await checkpointRun(workspaceId, runId, fencingToken, "research.kimi.extract");
  const synthesis = await synthesizeResearch({
    apiKey: kimiKey,
    documents,
    marketLabel: run.project.marketLabel,
    researchContext: run.project.researchContext,
    model: run.model as "zai-org/glm-5.2" | "moonshotai/kimi-k2.7-code",
    onUsage: onKimiUsage,
  });
  await recordAuditEvent({
    workspaceId,
    action: "kimi.research.completed",
    targetType: "workflow_run",
    targetId: runId,
    metadata: { model: run.model, documentCount: documents.length, schemaVersion: "research_synthesis_v1" },
  });
  const rankedCandidates = rankResearchCandidates(synthesis.candidates, documents);
  if (rankedCandidates.length === 0) throw new Error("Research did not produce a valid candidate.");
  await checkpointRun(
    workspaceId,
    runId,
    fencingToken,
    incrementalResearch ? "research.incremental.store" : "research.selection",
  );
  let storedFindingCount = 0;
  let storedEvidenceCount = 0;
  await db.$transaction(async (tx) => {
    const finalStep = incrementalResearch ? "research.incremental.store" : "research.selection";
    await guardRunTransaction(tx, workspaceId, runId, fencingToken, finalStep);
    if (!incrementalResearch) {
      const clearedSelection = await tx.project.updateMany({
        where: {
          id: run.projectId,
          workspaceId,
          currentSpecVersionId: null,
          optimisticVersion: run.project.optimisticVersion,
        },
        data: { selectedFindingId: null },
      });
      if (clearedSelection.count !== 1) {
        throw new Error("Project state changed before the ranked finding set could be replaced.");
      }
      await tx.finding.updateMany({
        where: { workspaceId, projectId: run.projectId, selectedAt: { not: null } },
        data: { selectedAt: null },
      });
      const replaceable = await tx.finding.findMany({
        where: { workspaceId, projectId: run.projectId, specVersions: { none: {} } },
        select: { id: true },
      });
      if (replaceable.length) {
        await tx.finding.deleteMany({
          where: {
            workspaceId,
            projectId: run.projectId,
            id: { in: replaceable.map((finding) => finding.id) },
          },
        });
      }
    }
    const existingFindings = incrementalResearch
      ? await tx.finding.findMany({ where: { workspaceId, projectId: run.projectId } })
      : [];
    const findingsByFingerprint = new Map(existingFindings.map((finding) => [
      researchCandidateFingerprint({
        title: finding.title,
        problem: finding.problemSummary,
        audience: finding.audience,
      }),
      finding,
    ]));
    for (const candidate of rankedCandidates) {
      let finding = findingsByFingerprint.get(candidate.fingerprint) ?? null;
      if (!finding) {
        finding = await tx.finding.create({
          data: {
            workspaceId,
            projectId: run.projectId,
            title: candidate.title,
            problemSummary: candidate.problem,
            solutionConcept: candidate.proposedSolution,
            audience: candidate.audience,
            originMode: run.project.researchMode,
            frequencyScore: candidate.frequency,
            severityScore: candidate.urgency,
            willingnessToPayScore: candidate.willingnessToPay,
            feasibilityScore: candidate.feasibility,
            totalScore: candidate.totalScore,
            scoreExplanation: `Rank ${candidate.rank}. Weighted from frequency, urgency, willingness to pay, and constrained MVP feasibility.`,
            selectedAt: null,
            model: run.model,
            promptVersion: "research-v1",
            schemaVersion: "1",
          },
        });
        findingsByFingerprint.set(candidate.fingerprint, finding);
        storedFindingCount += 1;
      }
      const existingEvidence = await tx.evidenceExcerpt.findMany({
        where: { workspaceId, projectId: run.projectId, findingId: finding.id },
        select: { sourceExternalId: true, contentHash: true },
      });
      const existingEvidenceKeys = new Set(existingEvidence.map((item) => `${item.sourceExternalId}:${item.contentHash}`));
      for (const document of candidate.documents.slice(0, 12)) {
        const excerpt = document.body.slice(0, 1_200);
        const contentHash = createHash("sha256").update(excerpt).digest("hex");
        if (existingEvidenceKeys.has(`${document.id}:${contentHash}`)) continue;
        const publishedAt = document.createdAt ? new Date(document.createdAt) : null;
        await tx.evidenceExcerpt.create({
          data: {
            workspaceId,
            projectId: run.projectId,
            findingId: finding.id,
            sourceExternalId: document.id,
            excerpt,
            permalink: "permalink" in document && typeof document.permalink === "string" ? document.permalink : null,
            attribution: (document.attribution ?? document.title).slice(0, 300),
            contentHash,
            sourcePublishedAt: publishedAt && !Number.isNaN(publishedAt.getTime()) ? publishedAt : null,
          },
        });
        existingEvidenceKeys.add(`${document.id}:${contentHash}`);
        storedEvidenceCount += 1;
      }
    }
    if (incrementalResearch) {
      await completeRun(
        tx,
        runId,
        workspaceId,
        run.projectId,
        fencingToken,
        `Incremental research retained ${storedEvidenceCount} new attributable evidence excerpt(s) across ${rankedCandidates.length} ranked finding(s) without changing the approved specification.`,
      );
      return;
    }
    await tx.project.update({
      where: { workspaceId_id: { workspaceId, id: run.projectId } },
      data: {
        status: "DRAFT",
        currentBlocker: "Choose one ranked finding before generating a ProductSpec",
        selectedFindingId: null,
        currentSpecVersionId: null,
        optimisticVersion: { increment: 1 },
      },
    });
    await completeRun(
      tx,
      runId,
      workspaceId,
      run.projectId,
      fencingToken,
      `Research persisted ${rankedCandidates.length} ranked finding(s) with ${storedEvidenceCount} attributable evidence excerpt(s); owner selection is required.`,
    );
  });
  return {
    runId,
    status: "succeeded",
    incremental: incrementalResearch,
    findingCount: rankedCandidates.length,
    createdFindingCount: storedFindingCount,
    evidenceCount: storedEvidenceCount,
    selectionRequired: !incrementalResearch,
  };
}

export async function executeSelectedFindingSpecification(
  workspaceId: string,
  runId: string,
  fencingToken: WorkflowFencingToken,
  selectedFindingId: string | null,
) {
  "use step";
  if (!selectedFindingId) throw new Error("Specification workflow has no selected finding.");
  const db = getDb();
  const run = await db.workflowRun.findFirstOrThrow({
    where: { id: runId, workspaceId },
    include: { project: true },
  });
  if (run.project.selectedFindingId !== selectedFindingId || run.project.currentSpecVersionId) {
    throw new Error("The selected finding changed or a ProductSpec already exists.");
  }
  const finding = await db.finding.findUnique({
    where: {
      workspaceId_projectId_id: {
        workspaceId,
        projectId: run.projectId,
        id: selectedFindingId,
      },
    },
    include: { evidence: { orderBy: { capturedAt: "asc" }, take: 25 } },
  });
  if (!finding || finding.evidence.length === 0) throw new Error("The selected finding has no attributable evidence.");
  const providerAccounts = await getBackendBuildProviderAccounts(workspaceId);
  const onKimiUsage = async (sample: Parameters<typeof recordKimiUsage>[0]["sample"]) => {
    const recorded = await recordKimiUsage({ workspaceId, projectId: run.projectId, runId, sample });
    if (recorded.exceeded) throw new Error("The run budget was exceeded; no further provider calls are allowed.");
  };
  const kimiKey = await getBackendKimiApiKey(workspaceId);
  await checkpointRun(workspaceId, runId, fencingToken, "research.kimi.spec");
  const evidence = finding.evidence.map((item) => ({
    id: item.id,
    excerpt: item.excerpt,
    attribution: item.attribution,
  }));
  const candidate = {
    title: finding.title,
    problem: finding.problemSummary,
    proposedSolution: finding.solutionConcept
      ?? "Create a focused, owner-reviewed workflow that directly resolves the selected evidence-backed problem.",
    audience: finding.audience,
    frequency: Number(finding.frequencyScore),
    urgency: Number(finding.severityScore),
    willingnessToPay: Number(finding.willingnessToPayScore),
    evidenceIds: evidence.map((item) => item.id),
  };
  const spec = ProductSpecSchema.parse(await generateProductSpec({
    apiKey: kimiKey,
    marketLabel: run.project.marketLabel,
    candidate,
    evidence,
    model: run.model as "zai-org/glm-5.2" | "moonshotai/kimi-k2.7-code",
    onUsage: onKimiUsage,
  }));
  const allowedEvidenceIds = new Set(evidence.map((item) => item.id));
  if (spec.evidenceIds.some((id) => !allowedEvidenceIds.has(id))) {
    throw new Error("Kimi cited evidence outside the selected persisted finding.");
  }
  const specHash = createHash("sha256").update(canonicalJson(spec)).digest("hex");
  await recordAuditEvent({
    workspaceId,
    action: "kimi.specification.completed",
    targetType: "workflow_run",
    targetId: runId,
    metadata: {
      findingId: finding.id,
      model: run.model,
      schemaVersion: "product_spec_v1",
    },
  });
  await checkpointRun(workspaceId, runId, fencingToken, "research.finalize");
  await db.$transaction(async (tx) => {
    await guardRunTransaction(tx, workspaceId, runId, fencingToken, "research.finalize");
    const currentProject = await tx.project.findUnique({
      where: { workspaceId_id: { workspaceId, id: run.projectId } },
      select: { selectedFindingId: true, currentSpecVersionId: true, optimisticVersion: true },
    });
    if (!currentProject
      || currentProject.selectedFindingId !== finding.id
      || currentProject.currentSpecVersionId
      || currentProject.optimisticVersion !== run.project.optimisticVersion) {
      throw new Error("Project state changed before the specification could be committed.");
    }
    const latest = await tx.productSpecVersion.aggregate({
      where: { workspaceId, projectId: run.projectId },
      _max: { version: true },
    });
    const specRecord = await tx.productSpecVersion.create({
      data: {
        workspaceId,
        projectId: run.projectId,
        basedOnFindingId: finding.id,
        version: (latest._max.version ?? 0) + 1,
        status: "PENDING_APPROVAL",
        content: spec,
        contentHash: specHash,
        model: run.model,
        promptVersion: "spec-v1",
        schemaVersion: "1",
      },
    });
    await tx.evidenceExcerpt.updateMany({
      where: {
        workspaceId,
        projectId: run.projectId,
        findingId: finding.id,
        id: { in: spec.evidenceIds },
      },
      data: { retainedBySpecVersionId: specRecord.id },
    });
    const payload: ApprovalPayload = {
      kind: "specification_build",
      workspaceId,
      projectId: run.projectId,
      projectOptimisticVersion: run.project.optimisticVersion + 1,
      providerAccounts,
      costCeilingMicros: Number(run.budgetCeilingMicros),
      expiresAt: new Date(Date.now() + 72 * 60 * 60_000).toISOString(),
      specVersionId: specRecord.id,
      specVersion: specRecord.version,
      specOptimisticVersion: specRecord.optimisticVersion,
      specHash,
    };
    const approval = createCanonicalApprovalRecord(payload);
    await tx.approval.create({
      data: {
        workspaceId,
        projectId: run.projectId,
        kind: "SPECIFICATION_BUILD",
        payload: approval.payload,
        payloadCanonical: approval.payloadCanonical,
        payloadHash: approval.payloadHash,
        specVersionId: specRecord.id,
        expiresAt: new Date(payload.expiresAt),
      },
    });
    const updatedProject = await tx.project.updateMany({
      where: {
        id: run.projectId,
        workspaceId,
        selectedFindingId: finding.id,
        currentSpecVersionId: null,
        optimisticVersion: run.project.optimisticVersion,
      },
      data: {
        status: "AWAITING_SPEC_APPROVAL",
        currentBlocker: "Specification approval required",
        currentSpecVersionId: specRecord.id,
        optimisticVersion: { increment: 1 },
      },
    });
    if (updatedProject.count !== 1) throw new Error("Project state changed before the specification approval was recorded.");
    await completeRun(tx, runId, workspaceId, run.projectId, fencingToken, "Selected finding produced a versioned ProductSpec and specification approval request.");
  });
  return { runId, status: "succeeded", findingId: finding.id, specHash };
}

export async function executeBuild(workspaceId: string, runId: string, fencingToken: WorkflowFencingToken, polish: boolean) {
  "use step";
  const db = getDb();
  const run = await db.workflowRun.findFirstOrThrow({
    where: { id: runId, workspaceId },
    include: { project: true, specVersion: true },
  });
  const specVersion = run.specVersion;
  if (!specVersion || specVersion.status !== "APPROVED") throw new Error("Build specification is not approved.");
  const onKimiUsage = async (sample: Parameters<typeof recordKimiUsage>[0]["sample"]) => {
    const recorded = await recordKimiUsage({ workspaceId, projectId: run.projectId, runId, sample });
    if (recorded.exceeded) throw new Error("The run budget was exceeded; no further provider calls are allowed.");
  };
  const existingLastKnownGood = await db.deployment.findFirst({
    where: { workspaceId, projectId: run.projectId, lastKnownGood: true },
    select: { id: true },
  });
  const polishRelease = polish || Boolean(existingLastKnownGood);
  const [kimiKey, daytonaKey] = await Promise.all([
    getBackendKimiApiKey(workspaceId),
    getBackendDaytonaApiKey(workspaceId),
  ]);
  let buildSpec = ProductSpecSchema.parse(specVersion.content);
  let polishProposal: {
    content: ReturnType<typeof ProductSpecSchema.parse>;
    contentHash: string;
    findingId: string;
    evidenceIds: string[];
  } | null = null;
  if (polish) {
    await checkpointRun(workspaceId, runId, fencingToken, "polish.evidence.delta");
    const incrementalEvidence = await db.evidenceExcerpt.findMany({
      where: {
        workspaceId,
        projectId: run.projectId,
        capturedAt: { gt: specVersion.createdAt },
        retainedBySpecVersionId: null,
      },
      orderBy: { capturedAt: "asc" },
      take: 100,
    });
    if (incrementalEvidence.length === 0) throw new Error("No incremental evidence is available for a polish proposal.");
    await checkpointRun(workspaceId, runId, fencingToken, "polish.spec.generate");
    buildSpec = ProductSpecSchema.parse(await improveProductSpec({
      apiKey: kimiKey,
      marketLabel: run.project.marketLabel,
      previousSpec: buildSpec,
      evidence: incrementalEvidence.map((item) => ({ id: item.id, excerpt: item.excerpt, attribution: item.attribution })),
      model: run.model as "zai-org/glm-5.2" | "moonshotai/kimi-k2.7-code",
      onUsage: onKimiUsage,
    }));
    polishProposal = {
      content: buildSpec,
      contentHash: createHash("sha256").update(canonicalJson(buildSpec)).digest("hex"),
      findingId: incrementalEvidence[0]!.findingId,
      evidenceIds: incrementalEvidence.filter((item) => buildSpec.evidenceIds.includes(item.id)).map((item) => item.id),
    };
    if (polishProposal.evidenceIds.length === 0) throw new Error("The polish proposal did not retain any supplied incremental evidence.");
    await recordAuditEvent({
      workspaceId,
      action: "kimi.polish_specification.completed",
      targetType: "workflow_run",
      targetId: runId,
      metadata: {
        model: run.model,
        promptVersion: "polish-v1",
        schemaVersion: "product_spec_polish_v1",
        evidenceCount: polishProposal.evidenceIds.length,
      },
    });
  }
  await checkpointRun(workspaceId, runId, fencingToken, "build.sandbox.create");
  const buildDeadlineAt = Date.now() + BUILD_WALL_CLOCK_LIMIT_MS;
  const result = await runTwoSandboxBuild({
    runId,
    productSpec: buildSpec,
    kimiApiKey: kimiKey,
    model: run.model as "zai-org/glm-5.2" | "moonshotai/kimi-k2.7-code",
    daytonaApiKey: daytonaKey,
    deadlineAt: buildDeadlineAt,
    onUsage: onKimiUsage,
    onPhase: (phase) => checkpointRun(workspaceId, runId, fencingToken, `build.${phase}`),
  });
  await checkpointRun(workspaceId, runId, fencingToken, "build.artifact.persist");
  await Promise.all([
    recordAuditEvent({
      workspaceId,
      action: "daytona.builder.completed",
      targetType: "sandbox",
      targetId: result.sandboxes.builderId,
      metadata: { runId, networkBlocked: true, credentials: false },
    }),
    recordAuditEvent({
      workspaceId,
      action: "daytona.verifier.completed",
      targetType: "sandbox",
      targetId: result.sandboxes.verifierId,
      metadata: { runId, networkBlocked: true, credentials: false, reportHash: result.verification.reportHash },
    }),
  ]);
  const sourceObjects = await mapConcurrent(result.repositoryFiles, 16, async (file) => ({
      path: file.path,
      ...(await putImmutableArtifact({ workspaceId, kind: "verified-source-file", body: file.content, contentType: "application/octet-stream" })),
    }));
  const outputObjects = await mapConcurrent(result.vercelOutput, 16, async (file) => ({
      path: file.path,
      ...(await putImmutableArtifact({ workspaceId, kind: "vercel-output-file", body: file.content, contentType: "application/octet-stream" })),
    }));
  const previewObjects = await mapConcurrent(result.previewStatic, 16, async (file) => ({
      path: file.path,
      ...(await putImmutableArtifact({ workspaceId, kind: "verified-preview-file", body: file.content, contentType: "application/octet-stream" })),
    }));
  const sourceIndex = Buffer.from(JSON.stringify({ manifest: result.repositoryManifest, files: sourceObjects }), "utf8");
  const outputIndex = Buffer.from(JSON.stringify({ manifest: result.outputManifest, files: outputObjects }), "utf8");
  const previewIndex = Buffer.from(JSON.stringify({ manifest: result.previewManifest, files: previewObjects }), "utf8");
  const [sourceIndexObject, outputIndexObject, previewIndexObject] = await Promise.all([
    putImmutableArtifact({ workspaceId, kind: "verified-source-index", body: sourceIndex, contentType: "application/json" }),
    putImmutableArtifact({ workspaceId, kind: "vercel-output-index", body: outputIndex, contentType: "application/json" }),
    putImmutableArtifact({ workspaceId, kind: "verified-preview-index", body: previewIndex, contentType: "application/json" }),
  ]);
  await checkpointRun(workspaceId, runId, fencingToken, "build.approval.finalize");
  await db.$transaction(async (tx) => {
    await guardRunTransaction(tx, workspaceId, runId, fencingToken, "build.approval.finalize");
    const canonicalProject = await tx.project.findUniqueOrThrow({ where: { id: run.projectId } });
    if (canonicalProject.currentSpecVersionId !== specVersion.id) {
      throw new Error("The project specification changed while the build was running.");
    }
    let effectiveSpecVersion = specVersion;
    if (polishProposal) {
      const latest = await tx.productSpecVersion.aggregate({ where: { projectId: run.projectId }, _max: { version: true } });
      effectiveSpecVersion = await tx.productSpecVersion.create({
        data: {
          workspaceId,
          projectId: run.projectId,
          basedOnFindingId: polishProposal.findingId,
          version: (latest._max.version ?? 0) + 1,
          status: "PENDING_APPROVAL",
          content: polishProposal.content,
          contentHash: polishProposal.contentHash,
          model: run.model,
          promptVersion: "polish-v1",
          schemaVersion: "product_spec_polish_v1",
        },
      });
      await tx.workflowRun.update({ where: { id: runId }, data: { specVersionId: effectiveSpecVersion.id } });
      await tx.evidenceExcerpt.updateMany({
        where: { workspaceId, projectId: run.projectId, id: { in: polishProposal.evidenceIds }, retainedBySpecVersionId: null },
        data: { retainedBySpecVersionId: effectiveSpecVersion.id },
      });
    }
    const sourceArtifact = await tx.buildArtifact.create({
      data: {
        workspaceId,
        projectId: run.projectId,
        runId,
        kind: "VERIFIED_SOURCE",
        objectKey: sourceIndexObject.key,
        artifactHash: result.repositoryManifest.artifactSha256,
        manifestHash: sourceIndexObject.sha256,
        byteSize: BigInt(result.repositoryManifest.totalBytes),
        fileCount: result.repositoryManifest.fileCount,
      },
    });
    const outputArtifact = await tx.buildArtifact.create({
      data: {
        workspaceId,
        projectId: run.projectId,
        runId,
        kind: "VERCEL_OUTPUT",
        objectKey: outputIndexObject.key,
        artifactHash: result.outputManifest.artifactSha256,
        manifestHash: outputIndexObject.sha256,
        byteSize: BigInt(result.outputManifest.totalBytes),
        fileCount: result.outputManifest.fileCount,
        signature: result.verification.signature,
        signatureKeyId: process.env.VERIFICATION_SIGNING_KEY_ID ?? "application-hmac-v1",
      },
    });
    await tx.buildArtifact.create({
      data: {
        workspaceId,
        projectId: run.projectId,
        runId,
        kind: "PREVIEW_STATIC",
        objectKey: previewIndexObject.key,
        artifactHash: result.previewManifest.artifactSha256,
        manifestHash: previewIndexObject.sha256,
        byteSize: BigInt(result.previewManifest.totalBytes),
        fileCount: result.previewManifest.fileCount,
        signature: result.verification.signature,
        signatureKeyId: process.env.VERIFICATION_SIGNING_KEY_ID ?? "application-hmac-v1",
        expiresAt: new Date(Date.now() + 48 * 60 * 60_000),
      },
    });
    const verificationReport = await tx.verificationReport.create({
      data: {
        workspaceId,
        projectId: run.projectId,
        artifactId: outputArtifact.id,
        status: "PASSED",
        verifierImage: result.verification.verifierSnapshot,
        report: result.verification,
        reportHash: result.verification.reportHash,
        signature: result.verification.signature,
        signatureKeyId: process.env.VERIFICATION_SIGNING_KEY_ID ?? "application-hmac-v1",
        verifiedAt: new Date(),
      },
    });
    const [connections, repositoryBinding, latestDeployment, grantedSecrets] = await Promise.all([
      tx.providerConnection.findMany({
        where: { workspaceId, provider: { in: ["GITHUB", "VERCEL"] }, health: "HEALTHY" },
      }),
      tx.repositoryBinding.findUnique({ where: { projectId: run.projectId } }),
      tx.deployment.findFirst({
        where: { workspaceId, projectId: run.projectId },
        orderBy: { createdAt: "desc" },
      }),
      tx.projectSecretGrant.findMany({
        where: {
          workspaceId,
          projectId: run.projectId,
          status: "ACTIVE",
          secretVersion: { revokedAt: null },
          approval: { artifactId: outputArtifact.id, status: "APPROVED" },
        },
        include: { secretVersion: true },
      }),
    ]);
    const github = connections.find((connection) => connection.provider === "GITHUB");
    const vercel = connections.find((connection) => connection.provider === "VERCEL");
    if (!github || !vercel) throw new Error("GitHub and Vercel must be healthy before release approval is created.");
    const githubOwnershipMarker = resourceOwnershipMarker({ provider: "github", workspaceId, projectId: run.projectId });
    const vercelOwnershipMarker = resourceOwnershipMarker({ provider: "vercel", workspaceId, projectId: run.projectId });
    const repositoryName = repositoryBinding?.name ?? collisionResistantResourceName(canonicalProject.slug, githubOwnershipMarker);
    const vercelProjectName = collisionResistantResourceName(canonicalProject.slug, vercelOwnershipMarker);
    const lastKnownGood = polishRelease
      ? await tx.deployment.findFirst({ where: { workspaceId, projectId: run.projectId, lastKnownGood: true } })
      : null;
    if (polishRelease && !lastKnownGood) throw new Error("A polish release requires a last-known-good deployment.");
    const releasePayload: ApprovalPayload = {
      kind: polishRelease ? "polish_release" : "first_release",
      workspaceId,
      projectId: run.projectId,
      projectOptimisticVersion: canonicalProject.optimisticVersion + 1,
      providerAccounts: [
        { provider: "github", accountId: github.accountExternalId ?? github.id },
        { provider: "vercel", accountId: vercel.accountExternalId ?? vercel.id },
      ],
      costCeilingMicros: 1_000_000,
      expiresAt: new Date(Date.now() + 48 * 60 * 60_000).toISOString(),
      specVersionId: effectiveSpecVersion.id,
      specVersion: effectiveSpecVersion.version,
      specOptimisticVersion: effectiveSpecVersion.optimisticVersion,
      specHash: effectiveSpecVersion.contentHash,
      artifactId: outputArtifact.id,
      artifactHash: outputArtifact.artifactHash,
      sourceArtifactId: sourceArtifact.id,
      sourceArtifactHash: sourceArtifact.artifactHash,
      verificationReportId: verificationReport.id,
      verificationReportHash: result.verification.reportHash,
      repository: {
        owner: repositoryBinding?.owner ?? github.accountLabel ?? github.accountExternalId ?? "owner",
        name: repositoryName,
        visibility: "private",
        installationId: repositoryBinding?.installationId ?? github.accountExternalId ?? "missing",
        externalRepositoryId: repositoryBinding?.externalRepositoryId ?? null,
        ownershipMarker: githubOwnershipMarker,
        optimisticVersion: repositoryBinding?.optimisticVersion ?? 0,
      },
      deployment: {
        provider: "vercel",
        teamId: vercel.accountExternalId ?? "missing",
        projectId: vercelProjectName,
        externalProjectId: latestDeployment?.externalProjectId ?? null,
        ownershipMarker: vercelOwnershipMarker,
        environment: "production",
        optimisticVersion: latestDeployment?.optimisticVersion ?? 0,
      },
      secretGrants: grantedSecrets.map((grant) => ({
        secretVersionId: grant.secretVersionId,
        name: grant.secretVersion.name,
        version: grant.secretVersion.version,
      })),
      ...(polishRelease
        ? {
            previousDeploymentId: lastKnownGood!.id,
            previousArtifactHash: lastKnownGood!.artifactHash,
          }
        : {}),
    } as ApprovalPayload;
    const approval = createCanonicalApprovalRecord(releasePayload);
    await tx.approval.create({
      data: {
        workspaceId,
        projectId: run.projectId,
        kind: polishRelease ? "POLISH_RELEASE" : "FIRST_RELEASE",
        payload: approval.payload,
        payloadCanonical: approval.payloadCanonical,
        payloadHash: approval.payloadHash,
        specVersionId: effectiveSpecVersion.id,
        artifactId: outputArtifact.id,
        upstreamArtifactId: sourceArtifact.id,
        expiresAt: new Date(releasePayload.expiresAt),
      },
    });
    await tx.project.update({
      where: { id: run.projectId },
      data: {
        status: "AWAITING_RELEASE_APPROVAL",
        currentBlocker: "Verified release approval required",
        ...(polishProposal ? { currentSpecVersionId: effectiveSpecVersion.id } : {}),
        optimisticVersion: { increment: 1 },
      },
    });
    await completeRun(tx, runId, workspaceId, run.projectId, fencingToken, "Two-sandbox verification passed; release approval requested.");
  });
  return { runId, status: "succeeded", artifactHash: result.outputManifest.artifactSha256 };
}

async function completeRun(
  tx: Parameters<Parameters<ReturnType<typeof getDb>["$transaction"]>[0]>[0],
  runId: string,
  workspaceId: string,
  projectId: string,
  fencingToken: WorkflowFencingToken,
  message: string,
) {
  const completedAt = new Date();
  await requireCurrentRunLease(
    (args) => tx.runLease.updateMany(args),
    { workspaceId, runId, fencingToken, now: completedAt },
    "Workflow lease changed before completion could be recorded.",
  );
  const run = await tx.workflowRun.findUnique({ where: { id: runId }, select: { scheduleId: true, attempt: true } });
  await tx.workflowStep.updateMany({ where: { runId, status: "RUNNING" }, data: { status: "SUCCEEDED", finishedAt: completedAt } });
  await tx.workflowStep.updateMany({ where: { runId, status: { in: ["PENDING", "WAITING"] } }, data: { status: "SKIPPED", finishedAt: completedAt } });
  await tx.workflowRun.update({
    where: { id: runId },
    data: { status: "SUCCEEDED", finishedAt: completedAt, currentStepKey: null, stateVersion: { increment: 1 } },
  });
  if (isCustomerCreditsEnforced()) {
    if (!run) throw new Error("Workflow run disappeared before customer credits could be settled.");
    const reservation = await tx.creditReservation.findUnique({
      where: { runId_runAttempt: { runId, runAttempt: run.attempt } },
      select: { id: true },
    });
    if (!reservation) throw new Error("Workflow run has no customer credit reservation to settle.");
    await settleCreditReservation(tx, { workspaceId, reservationId: reservation.id, now: completedAt });
  }
  const openReservations = await tx.budgetReservation.findMany({
    where: { runId, status: { in: ["RESERVED", "EXCEEDED"] } },
    select: { id: true, provider: true, reservedMicros: true, actualMicros: true },
  });
  let committedActualMicros = 0n;
  for (const reservation of openReservations) {
    const actualMicros = reservation.actualMicros ?? (reservation.provider === "KIMI" ? 0n : reservation.reservedMicros);
    committedActualMicros += actualMicros;
    if (reservation.provider !== "KIMI" && reservation.actualMicros === null) {
      await tx.usageLedger.upsert({
        where: {
          workspaceId_provider_externalUsageId: {
            workspaceId,
            provider: reservation.provider,
            externalUsageId: `${runId}:approved-cost-ceiling`,
          },
        },
        create: {
          workspaceId,
          projectId,
          runId,
          provider: reservation.provider,
          externalUsageId: `${runId}:approved-cost-ceiling`,
          model: "not_applicable",
          operation: "approved_cost_ceiling_commit",
          inputRateMicrosPerMillion: null,
          outputRateMicrosPerMillion: null,
          pricingVersion: null,
          costMicros: actualMicros,
          metadata: { estimated: true, basis: "approved_cost_ceiling" },
          occurredAt: completedAt,
        },
        update: {},
      });
    }
    await tx.budgetReservation.update({
      where: { id: reservation.id },
      data: { status: "COMMITTED", actualMicros, committedAt: new Date() },
    });
  }
  await tx.workflowRun.update({ where: { id: runId }, data: { actualCostMicros: committedActualMicros } });
  if (!(await releaseCurrentRunLease((args) => tx.runLease.updateMany(args), { workspaceId, runId, fencingToken }))) {
    throw new Error("Workflow lease changed while completion was being recorded.");
  }
  if (run?.scheduleId) {
    await tx.schedule.update({
      where: { id: run.scheduleId },
      data: {
        lastCompletedAt: completedAt,
        consecutiveFailures: 0,
        backoffUntil: null,
        optimisticVersion: { increment: 1 },
      },
    });
  }
  await tx.activityEvent.create({
    data: {
      workspaceId,
      projectId,
      runId,
      type: "workflow.run.succeeded",
      severity: "SUCCESS",
      message,
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60_000),
    },
  });
}
