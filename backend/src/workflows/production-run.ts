import "server-only";

import { createHash } from "node:crypto";

import { getDb } from "@/server/db";
import { recordAuditEvent } from "@/server/audit";
import { canonicalJson } from "@/server/security/canonical-json";
import { redactSecrets } from "@/policy/secret-guard";
import { start } from "workflow/api";
import { ProjectConfigSchema } from "@/contracts";
import { assertWorkspaceBudgetAvailable } from "@/server/budget";
import { getBackendBuildProviderAccounts } from "@/server/backend-providers";
import { reserveCredits, releaseCreditReservation } from "@/server/credits";
import { isCustomerCreditsEnforced } from "@/server/env";
import { withSerializableTransaction } from "@/server/transactions";

import { executeRunWorkflow } from "./executor";

const stepLabels: Record<"research" | "build" | "polish", Array<[string, string]>> = {
  research: [
    ["source", "Load authorized evidence"],
    ["extract", "Extract structured problems"],
    ["selection", "Persist ranked findings for selection"],
  ],
  build: [
    ["approval", "Consume specification approval"],
    ["builder", "Constrained Kimi builder"],
    ["verifier", "Fresh sandbox verification"],
    ["artifact", "Persist verified artifacts"],
    ["approval_release", "Request release approval"],
  ],
  polish: [
    ["evidence_delta", "Review incremental evidence"],
    ["builder", "Build proposed polish"],
    ["verifier", "Verify proposed polish"],
    ["approval_release", "Request polish approval"],
  ],
};

const incrementalResearchSteps: Array<[string, string]> = [
  ["source", "Load newly authorized evidence"],
  ["extract", "Extract incremental problem signals"],
  ["store", "Persist incremental evidence"],
];

const specificationSteps: Array<[string, string]> = [
  ["spec", "Generate product specification"],
  ["approval", "Request specification approval"],
];

type ResearchWorkflowPurpose = "research" | "specification";

function productionCreditOperation(kind: "research" | "build" | "polish", purpose: ResearchWorkflowPurpose) {
  if (kind === "research") return purpose;
  return kind;
}

export async function createProductionRun(input: {
  workspaceId: string;
  projectId: string;
  kind: "research" | "build" | "polish";
  specVersionId?: string;
  budgetCeilingMicros: number;
  idempotencyKey: string;
  parentRunId?: string;
  scheduleId?: string;
  attempt?: number;
  workflowPurpose?: ResearchWorkflowPurpose;
  findingId?: string;
  expectedProjectVersion?: number;
  expectedParentRunVersion?: number;
}) {
  const db = getDb();
  let workflowPurpose = input.workflowPurpose ?? "research";
  let findingId = input.findingId;
  let expectedProjectVersion = input.expectedProjectVersion;
  const existing = await db.workflowRun.findUnique({
    where: { workspaceId_idempotencyKey: { workspaceId: input.workspaceId, idempotencyKey: input.idempotencyKey } },
  });
  if (existing) {
    const existingEvent = await db.outboxEvent.findUnique({
      where: { workspaceId_idempotencyKey: { workspaceId: input.workspaceId, idempotencyKey: `${input.idempotencyKey}:outbox` } },
      select: { payload: true },
    });
    const existingPayload = existingEvent?.payload && typeof existingEvent.payload === "object" && !Array.isArray(existingEvent.payload)
      ? existingEvent.payload as Record<string, unknown>
      : {};
    const replayPurpose = input.workflowPurpose
      ?? (input.parentRunId && existingPayload.purpose === "specification" ? "specification" : "research");
    const replayFindingId = input.findingId
      ?? (input.parentRunId && typeof existingPayload.findingId === "string" ? existingPayload.findingId : undefined);
    const replayExpectedProjectVersion = input.expectedProjectVersion
      ?? (input.parentRunId && typeof existingPayload.expectedProjectVersion === "number" ? existingPayload.expectedProjectVersion : undefined);
    const sameRequest =
      existing.projectId === input.projectId &&
      existing.kind === input.kind.toUpperCase() &&
      existing.parentRunId === (input.parentRunId ?? null) &&
      existing.budgetCeilingMicros === BigInt(input.budgetCeilingMicros) &&
      existing.scheduleId === (input.scheduleId ?? null) &&
      (!input.specVersionId || existing.specVersionId === input.specVersionId) &&
      (existingPayload.purpose ?? "research") === replayPurpose &&
      (existingPayload.findingId ?? null) === (replayFindingId ?? null) &&
      (existingPayload.expectedProjectVersion ?? null) === (replayExpectedProjectVersion ?? null) &&
      (existingPayload.expectedParentRunVersion ?? null) === (input.expectedParentRunVersion ?? null);
    if (!sameRequest) throw new Error("Idempotency key conflict: this key was used for a different run request.");
    return { run: existing, replayed: true };
  }
  if (input.parentRunId && input.kind === "research") {
    const parentEvent = await db.outboxEvent.findFirst({
      where: {
        workspaceId: input.workspaceId,
        aggregateType: "workflow_run",
        aggregateId: input.parentRunId,
        eventType: "workflow.run.queued",
      },
      orderBy: { createdAt: "desc" },
      select: { payload: true },
    });
    const parentPayload = parentEvent?.payload && typeof parentEvent.payload === "object" && !Array.isArray(parentEvent.payload)
      ? parentEvent.payload as Record<string, unknown>
      : {};
    if (parentPayload.purpose === "specification") {
      if (input.workflowPurpose && input.workflowPurpose !== "specification") {
        throw new Error("A specification retry cannot be changed into a research run.");
      }
      if (typeof parentPayload.findingId !== "string" || !parentPayload.findingId) {
        throw new Error("The parent specification run is missing its selected finding.");
      }
      workflowPurpose = "specification";
      findingId = input.findingId ?? parentPayload.findingId;
      if (findingId !== parentPayload.findingId) throw new Error("The retry selected finding does not match its parent run.");
      if (expectedProjectVersion === undefined) {
        const project = await db.project.findUnique({
          where: { workspaceId_id: { workspaceId: input.workspaceId, id: input.projectId } },
          select: { optimisticVersion: true },
        });
        if (!project) throw new Error("Project not found.");
        expectedProjectVersion = project.optimisticVersion;
      }
    }
  }
  const specificationProviderAccounts = workflowPurpose === "specification"
    ? await getBackendBuildProviderAccounts(input.workspaceId)
    : null;
  const run = await withSerializableTransaction(
    db,
    async (tx) => {
      const project = await tx.project.findUnique({
        where: { workspaceId_id: { workspaceId: input.workspaceId, id: input.projectId } },
        include: { workspace: true },
      });
      if (!project) throw new Error("Project not found.");
      if (expectedProjectVersion !== undefined && project.optimisticVersion !== expectedProjectVersion) {
        throw new Error("Project version conflict.");
      }
      if (project.status === "PAUSED" || project.status === "ARCHIVED") throw new Error("The project is not accepting new runs.");
      if (workflowPurpose === "specification") {
        if (input.kind !== "research" || !findingId || expectedProjectVersion === undefined) {
          throw new Error("A selected finding and optimistic project version are required for specification generation.");
        }
        if (project.optimisticVersion !== expectedProjectVersion) throw new Error("Project version conflict.");
        if (project.selectedFindingId !== findingId) throw new Error("The selected finding changed before specification generation could be queued.");
        if (project.currentSpecVersionId) throw new Error("A ProductSpec already exists for this project.");
        const finding = await tx.finding.findUnique({
          where: {
            workspaceId_projectId_id: {
              workspaceId: input.workspaceId,
              projectId: input.projectId,
              id: findingId,
            },
          },
          include: { evidence: { select: { id: true }, take: 1 } },
        });
        if (!finding || finding.evidence.length === 0) throw new Error("The selected finding or its attributable evidence is unavailable.");
        if (!specificationProviderAccounts || specificationProviderAccounts.length !== 2) {
          throw new Error("Kimi and Daytona must both be healthy before ProductSpec generation can be queued.");
        }
      }
      const projectConfig = ProjectConfigSchema.parse(project.config);
      if (input.budgetCeilingMicros < 1) throw new Error("A positive run budget ceiling is required before provider work can start.");
      if (input.budgetCeilingMicros > projectConfig.maxCostMicrosPerRun) {
        throw new Error("The requested run budget exceeds the project cost ceiling.");
      }
      const incrementalResearch = input.kind === "research"
        && workflowPurpose === "research"
        && Boolean(project.currentSpecVersionId);
      const retryParent = input.parentRunId
        ? await tx.workflowRun.findFirst({
            where: {
              id: input.parentRunId,
              workspaceId: input.workspaceId,
              projectId: input.projectId,
              kind: input.kind.toUpperCase() as Uppercase<typeof input.kind>,
              status: { in: ["FAILED", "CANCELED"] },
              ...(input.expectedParentRunVersion !== undefined ? { stateVersion: input.expectedParentRunVersion } : {}),
            },
          })
        : null;
      if (input.parentRunId && !retryParent) throw new Error("The retry parent is unavailable or incompatible.");
      if (
        input.kind === "research"
        && !input.scheduleId
        && ["BUILDING", "AWAITING_SPEC_APPROVAL", "AWAITING_RELEASE_APPROVAL"].includes(project.status)
      ) {
        throw new Error("Manual research is unavailable while a build or approval decision is active.");
      }
      if (input.kind === "build" && !retryParent && project.status !== "READY_TO_BUILD") {
        throw new Error("The project is not ready to start a newly approved build.");
      }
      if (input.kind === "build" || input.kind === "polish") {
        const activeProjectBuild = await tx.workflowRun.findFirst({
          where: {
            workspaceId: input.workspaceId,
            projectId: input.projectId,
            kind: { in: ["BUILD", "POLISH"] },
            status: { in: ["QUEUED", "RUNNING", "WAITING_FOR_APPROVAL", "CANCEL_REQUESTED"] },
          },
          select: { id: true },
        });
        if (activeProjectBuild) throw new Error("An active build or pending build cleanup already exists for this project.");
        const activeBuilds = await tx.workflowRun.count({
          where: {
            workspaceId: input.workspaceId,
            kind: { in: ["BUILD", "POLISH"] },
            status: { in: ["QUEUED", "RUNNING", "WAITING_FOR_APPROVAL", "CANCEL_REQUESTED"] },
          },
        });
        if ((activeBuilds + 1) * 2 > project.workspace.maxConcurrentSandboxes) {
          throw new Error("The workspace sandbox concurrency limit is already reserved.");
        }
      } else {
        const activeResearch = await tx.workflowRun.findFirst({
          where: {
            workspaceId: input.workspaceId,
            projectId: input.projectId,
            kind: "RESEARCH",
            status: { in: ["QUEUED", "RUNNING", "WAITING_FOR_APPROVAL", "CANCEL_REQUESTED"] },
          },
          select: { id: true },
        });
        if (activeResearch) throw new Error("Active research or pending research cancellation already exists for this project.");
      }
      let specVersionId = input.specVersionId;
      if (input.kind === "build" || input.kind === "polish") {
        specVersionId ??= project.currentSpecVersionId ?? undefined;
        if (!specVersionId) throw new Error("An approved specification is required.");
        const spec = await tx.productSpecVersion.findUnique({
          where: { workspaceId_projectId_id: { workspaceId: input.workspaceId, projectId: input.projectId, id: specVersionId } },
        });
        if (!spec || spec.status !== "APPROVED") throw new Error("The selected specification is not approved.");
        if (retryParent && retryParent.specVersionId !== spec.id) {
          throw new Error("The retry specification does not match its parent run.");
        }
        if (input.kind === "build" && !retryParent) {
          const approval = await tx.approval.findFirst({
            where: {
              workspaceId: input.workspaceId,
              projectId: input.projectId,
              specVersionId,
              kind: "SPECIFICATION_BUILD",
              status: "APPROVED",
              expiresAt: { gt: new Date() },
            },
            orderBy: { createdAt: "desc" },
          });
          if (!approval) throw new Error("The specification build approval is unavailable or expired.");
          await tx.approval.update({
            where: { id: approval.id },
            data: { status: "CONSUMED", consumedAt: new Date(), optimisticVersion: { increment: 1 } },
          });
        }
      }
      if (input.kind === "research" && workflowPurpose === "research" && project.researchMode === "LIVE_REDDIT") {
        const source = await tx.researchSource.findFirst({
          where: {
            workspaceId: input.workspaceId,
            projectId: input.projectId,
            mode: "LIVE_REDDIT",
            status: "ACTIVE",
            authorizationReference: { not: null },
          },
        });
        if (!source) throw new Error("Live Reddit remains locked until written authorization is recorded.");
      }
      const ceiling = BigInt(input.budgetCeilingMicros);
      await assertWorkspaceBudgetAvailable(tx, {
        workspaceId: input.workspaceId,
        monthlyBudgetMicros: project.workspace.monthlyBudgetMicros,
        requestedMicros: ceiling,
      });
      const created = await tx.workflowRun.create({
        data: {
          workspaceId: input.workspaceId,
          projectId: input.projectId,
          specVersionId: specVersionId ?? null,
          parentRunId: input.parentRunId ?? null,
          scheduleId: input.scheduleId ?? null,
          attempt: input.attempt ?? 1,
          kind: input.kind.toUpperCase() as Uppercase<typeof input.kind>,
          status: "QUEUED",
          idempotencyKey: input.idempotencyKey,
          budgetCeilingMicros: ceiling,
          reservedMicros: ceiling,
          steps: {
            create: (
              workflowPurpose === "specification"
                ? specificationSteps
                : incrementalResearch
                  ? incrementalResearchSteps
                  : stepLabels[input.kind]
            ).map(([key, label]) => ({
              workspaceId: input.workspaceId,
              projectId: input.projectId,
              key,
              label,
              ...(input.kind === "build" && key === "approval"
                ? { status: "SUCCEEDED" as const, startedAt: new Date(), finishedAt: new Date() }
                : {}),
            })),
          },
        },
      });
      if (isCustomerCreditsEnforced()) {
        await reserveCredits(tx, {
          workspaceId: input.workspaceId,
          projectId: input.projectId,
          runId: created.id,
          runAttempt: created.attempt,
          operation: productionCreditOperation(input.kind, workflowPurpose),
        });
      }
      const resourceKey = `${input.kind === "build" || input.kind === "polish" ? "build" : "research"}:${input.projectId}`;
      const currentLease = await tx.runLease.findUnique({
        where: { workspaceId_resourceKey: { workspaceId: input.workspaceId, resourceKey } },
      });
      if (currentLease && !currentLease.releasedAt && currentLease.expiresAt > new Date()) {
        throw new Error(`An active ${input.kind === "research" ? "research" : "build"} run already holds this project lease.`);
      }
      if (currentLease) {
        await tx.runLease.update({
          where: { id: currentLease.id },
          data: {
            projectId: input.projectId,
            runId: created.id,
            ownerId: created.id,
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
            projectId: input.projectId,
            runId: created.id,
            resourceKey,
            ownerId: created.id,
            fencingToken: 1n,
            expiresAt: new Date(Date.now() + 45 * 60_000),
          },
        });
      }
      await tx.budgetReservation.create({
        data: {
          workspaceId: input.workspaceId,
          projectId: input.projectId,
          runId: created.id,
          provider: "KIMI",
          idempotencyKey: `${input.idempotencyKey}:budget`,
          reservedMicros: ceiling,
          expiresAt: new Date(Date.now() + 60 * 60_000),
        },
      });
      const payload = {
        runId: created.id,
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        kind: input.kind,
        ...(workflowPurpose === "specification"
          ? {
              purpose: workflowPurpose,
              findingId: findingId!,
              expectedProjectVersion: expectedProjectVersion!,
            }
          : {}),
        ...(workflowPurpose !== "specification" && expectedProjectVersion !== undefined
          ? { expectedProjectVersion }
          : {}),
        ...(input.expectedParentRunVersion !== undefined
          ? { expectedParentRunVersion: input.expectedParentRunVersion }
          : {}),
      };
      const payloadHash = createHash("sha256").update(canonicalJson(payload)).digest("hex");
      await tx.outboxEvent.create({
        data: {
          workspaceId: input.workspaceId,
          aggregateType: "workflow_run",
          aggregateId: created.id,
          aggregateVersion: 1,
          eventType: "workflow.run.queued",
          payload,
          payloadHash,
          idempotencyKey: `${input.idempotencyKey}:outbox`,
        },
      });
      if (!incrementalResearch) {
        await tx.project.update({
          where: { id: input.projectId, workspaceId: input.workspaceId, optimisticVersion: project.optimisticVersion },
          data: {
            status: input.kind === "research" ? "RESEARCHING" : "BUILDING",
            currentBlocker: null,
            optimisticVersion: { increment: 1 },
          },
        });
      }
      return created;
    },
    { timeoutMs: 15_000 },
  );
  return { run, replayed: false };
}

export async function createSpecificationRun(input: {
  workspaceId: string;
  projectId: string;
  findingId: string;
  expectedProjectVersion: number;
  budgetCeilingMicros: number;
  idempotencyKey: string;
}) {
  return createProductionRun({
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    kind: "research",
    budgetCeilingMicros: input.budgetCeilingMicros,
    idempotencyKey: input.idempotencyKey,
    workflowPurpose: "specification",
    findingId: input.findingId,
    expectedProjectVersion: input.expectedProjectVersion,
  });
}

export async function dispatchProductionRun(workspaceId: string, runId: string) {
  const db = getDb();
  const event = await db.outboxEvent.findFirst({
    where: {
      workspaceId,
      aggregateType: "workflow_run",
      aggregateId: runId,
      eventType: { in: ["workflow.run.queued", "workflow.release.queued", "workflow.rollback.queued"] },
    },
    orderBy: { createdAt: "desc" },
  });
  if (!event) throw new Error("Workflow outbox event not found.");
  const existingPayload = event.payload as Record<string, unknown>;
  if (event.publishedAt) return typeof existingPayload.executorRunId === "string" ? existingPayload.executorRunId : null;

  const run = await db.workflowRun.findFirst({ where: { id: runId, workspaceId } });
  let payloadHash = "invalid";
  try {
    payloadHash = createHash("sha256").update(canonicalJson(existingPayload)).digest("hex");
  } catch {
    // Dead-lettered below without echoing unsafe payload details.
  }
  if (
    !run ||
    payloadHash !== event.payloadHash ||
    existingPayload.runId !== runId ||
    existingPayload.workspaceId !== workspaceId ||
    existingPayload.projectId !== run.projectId
  ) {
    await db.$transaction(async (tx) => {
      await tx.outboxEvent.update({
        where: { id: event.id },
        data: { publishedAt: new Date(), lastError: "dead_letter_invalid_workflow_event" },
      });
      if (run?.status === "QUEUED") {
        await tx.workflowRun.update({
          where: { id: run.id },
          data: { status: "FAILED", failureCode: "invalid_outbox", failureMessage: "Workflow event integrity validation failed.", finishedAt: new Date(), stateVersion: { increment: 1 } },
        });
        const failedAt = new Date();
        await tx.budgetReservation.updateMany({
          where: { runId: run.id, status: "RESERVED" },
          data: { status: "RELEASED", releasedAt: failedAt },
        });
        if (isCustomerCreditsEnforced()) {
          const reservation = await tx.creditReservation.findUnique({
            where: { runId_runAttempt: { runId: run.id, runAttempt: run.attempt } },
            select: { id: true, status: true },
          });
          if (reservation?.status === "HELD") {
            await releaseCreditReservation(tx, { workspaceId, reservationId: reservation.id, now: failedAt });
          }
        }
      }
    });
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

  if (run.status !== "QUEUED") {
    const hasPersistedExecutorId =
      typeof existingPayload.executorRunId === "string" ||
      (Array.isArray(existingPayload.executorRunIds) && existingPayload.executorRunIds.some((value) => typeof value === "string"));
    // If a previous publisher attempt crossed start() but failed before persisting
    // the returned ID, a later canonical-state check cannot prove that no executor
    // exists. Preserve that uncertainty for cancellation reconciliation.
    const canonicalReason = run ? `canonical_${run.status.toLowerCase()}` : "canonical_run_missing";
    const lastError = event.attemptCount > 0 && !hasPersistedExecutorId
      ? `unresolved_executor_start:${canonicalReason}`
      : canonicalReason;
    await db.outboxEvent.updateMany({
      where: { id: event.id, publishedAt: null, availableAt: leaseUntil },
      data: { publishedAt: new Date(), lastError },
    });
    return null;
  }

  try {
    const durable = await start(executeRunWorkflow, [workspaceId, runId]);
    const previousIds = Array.isArray(existingPayload.executorRunIds)
      ? existingPayload.executorRunIds.filter((value): value is string => typeof value === "string")
      : [];
    const payload = {
      ...existingPayload,
      executorRunId: durable.runId,
      executorRunIds: [...new Set([...previousIds, durable.runId])],
    };
    const completed = await db.outboxEvent.updateMany({
      where: { id: event.id, publishedAt: null, availableAt: leaseUntil },
      data: {
        payload,
        payloadHash: createHash("sha256").update(canonicalJson(payload)).digest("hex"),
        publishedAt: new Date(),
        lastError: null,
      },
    });
    if (completed.count !== 1) throw new Error("Workflow outbox publisher lease was lost.");
    await recordAuditEvent({
      workspaceId,
      action: "workflow.executor.enqueued",
      targetType: "workflow_run",
      targetId: runId,
      metadata: { executorRunId: durable.runId },
    }).catch(() => undefined);
    return durable.runId;
  } catch (error) {
    const attempt = event.attemptCount + 1;
    const delayMs = Math.min(5_000 * 2 ** Math.min(Math.max(attempt - 1, 0), 6), 5 * 60_000);
    await db.outboxEvent.updateMany({
      where: { id: event.id, publishedAt: null, availableAt: leaseUntil },
      data: {
        availableAt: new Date(Date.now() + delayMs),
        lastError: redactSecrets(error instanceof Error ? error.message : "Workflow dispatch failed.").slice(0, 1_000),
      },
    });
    return null;
  }
}

export async function reconcileWorkflowOutbox(limit = 50) {
  const db = getDb();
  const now = new Date();
  const stale = await db.outboxEvent.findMany({
    where: {
      aggregateType: "workflow_run",
      eventType: { in: ["workflow.run.queued", "workflow.release.queued", "workflow.rollback.queued"] },
      publishedAt: { lt: new Date(now.getTime() - 2 * 60_000) },
    },
    orderBy: { publishedAt: "asc" },
    take: limit,
  });
  for (const event of stale) {
    const run = await db.workflowRun.findFirst({ where: { id: event.aggregateId, workspaceId: event.workspaceId } });
    if (run?.status === "QUEUED") {
      await db.outboxEvent.updateMany({
        where: { id: event.id, publishedAt: event.publishedAt },
        data: { publishedAt: null, availableAt: now, lastError: "canonical_run_still_queued" },
      });
    }
  }

  const pending = await db.outboxEvent.findMany({
    where: {
      aggregateType: "workflow_run",
      eventType: { in: ["workflow.run.queued", "workflow.release.queued", "workflow.rollback.queued"] },
      publishedAt: null,
      availableAt: { lte: now },
    },
    orderBy: { availableAt: "asc" },
    take: limit,
  });
  let dispatched = 0;
  for (const event of pending) {
    if (await dispatchProductionRun(event.workspaceId, event.aggregateId)) dispatched += 1;
  }
  return { inspected: pending.length + stale.length, dispatched, pending: pending.length - dispatched };
}

export { serializeRunState as serializeRun } from "./run-serialization";
