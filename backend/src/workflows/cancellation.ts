import "server-only";

import type { RunKind, WorkflowRun } from "@prisma/client";
import { getRun as getDurableRun } from "workflow/api";

import { cleanupRunSandboxes } from "@/integrations/daytona";
import { redactSecrets } from "@/policy/secret-guard";
import { releaseCreditReservation } from "@/server/credits";
import { getBackendDaytonaApiKey } from "@/server/backend-providers";
import { getDb } from "@/server/db";
import { isCustomerCreditsEnforced } from "@/server/env";

import { releaseCurrentRunLease, requireCurrentRunLease } from "./lease-fencing";

const terminalExecutorStatuses = new Set(["completed", "failed", "cancelled"]);
const irreversibleCancellationSteps = new Set([
  "release.promote",
  "release.finalize",
  "rollback.promote",
  "rollback.finalize",
]);

type ExecutorRunHandle = {
  cancel: () => Promise<void>;
  exists: Promise<boolean>;
  status: Promise<string>;
};

export type ExecutorResolver = (runId: string) => ExecutorRunHandle;

export type ExecutorCancellationResult = {
  confirmedStopped: boolean;
  failures: string[];
  statuses: Array<{ runId: string; status: string }>;
};

export type CancellationReconciliation = {
  run: WorkflowRun;
  durableExecutorsConfirmedStopped: boolean;
  sandboxCleanupRequired: boolean;
  sandboxCleanupConfirmed: boolean;
  deletedSandboxes: string[];
  pendingReason: string | null;
};

export function executorRunIdsFromPayloads(payloads: unknown[]) {
  const ids = new Set<string>();
  for (const payload of payloads) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) continue;
    const record = payload as Record<string, unknown>;
    if (typeof record.executorRunId === "string" && record.executorRunId) ids.add(record.executorRunId);
    if (Array.isArray(record.executorRunIds)) {
      for (const candidate of record.executorRunIds) {
        if (typeof candidate === "string" && candidate) ids.add(candidate);
      }
    }
  }
  return [...ids];
}

export function cancellationNeedsSandboxCleanup(kind: RunKind) {
  return kind === "BUILD" || kind === "POLISH";
}

/**
 * A terminal status is read back after cancel(). A successful cancel request alone is
 * not proof that a durable executor has stopped processing its current step.
 */
export async function cancelAndConfirmDurableExecutors(
  executorRunIds: string[],
  resolve: ExecutorResolver = (runId) => getDurableRun(runId),
): Promise<ExecutorCancellationResult> {
  const results = await Promise.all(
    executorRunIds.map(async (runId) => {
      try {
        const handle = resolve(runId);
        if (!(await handle.exists)) return { runId, status: "missing", stopped: true as const };
        const before = await handle.status;
        if (terminalExecutorStatuses.has(before)) return { runId, status: before, stopped: true as const };
        await handle.cancel();
        const after = await handle.status;
        return { runId, status: after, stopped: terminalExecutorStatuses.has(after) };
      } catch {
        return { runId, status: "unavailable", stopped: false as const };
      }
    }),
  );
  return {
    confirmedStopped: results.every((result) => result.stopped),
    failures: results.filter((result) => !result.stopped).map((result) => result.runId),
    statuses: results.map(({ runId, status }) => ({ runId, status })),
  };
}

export function executorDispatchIsAccountedFor(
  events: Array<{ attemptCount: number; publishedAt: Date | null; lastError: string | null }>,
  executorRunIds: string[],
) {
  if (events.length === 0) return false;
  if (executorRunIds.length > 0) return true;
  return events.every(
    (event) =>
      event.attemptCount === 0 ||
      (event.publishedAt !== null && Boolean(event.lastError?.startsWith("canonical_") || event.lastError?.startsWith("dead_letter_"))),
  );
}

export function cancellationCanFinalize(input: {
  durableExecutorsConfirmedStopped: boolean;
  sandboxCleanupRequired: boolean;
  sandboxCleanupConfirmed: boolean;
}) {
  return (
    input.durableExecutorsConfirmedStopped &&
    (!input.sandboxCleanupRequired || input.sandboxCleanupConfirmed)
  );
}

async function markCancellationPending(workspaceId: string, runId: string, unsafeReason: string) {
  const db = getDb();
  const reason = redactSecrets(unsafeReason).slice(0, 1_000);
  await db.$transaction(async (tx) => {
    const changed = await tx.workflowRun.updateMany({
      where: { id: runId, workspaceId, status: "CANCEL_REQUESTED" },
      data: {
        failureCode: "cancellation_pending",
        failureMessage: reason,
        stateVersion: { increment: 1 },
      },
    });
    if (changed.count !== 1) return;
    await tx.runLease.updateMany({
      where: { workspaceId, runId, ownerId: runId, releasedAt: null },
      data: { expiresAt: new Date(Date.now() + 2 * 60 * 60_000) },
    });
    const existing = await tx.activityEvent.findFirst({
      where: { workspaceId, runId, type: "workflow.run.cancellation_pending" },
      select: { id: true },
    });
    if (existing) return;
    const run = await tx.workflowRun.findUniqueOrThrow({ where: { id: runId }, select: { projectId: true } });
    await tx.activityEvent.create({
      data: {
        workspaceId,
        projectId: run.projectId,
        runId,
        type: "workflow.run.cancellation_pending",
        severity: "WARNING",
        message: "Cancellation is pending durable executor shutdown and sandbox cleanup confirmation.",
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60_000),
      },
    });
  });
}

async function finalizeCanceledRun(input: {
  workspaceId: string;
  runId: string;
  deletedSandboxes: string[];
}) {
  const db = getDb();
  return db.$transaction(async (tx) => {
    const run = await tx.workflowRun.findFirst({ where: { id: input.runId, workspaceId: input.workspaceId } });
    if (!run) throw new Error("Run not found.");
    if (run.status === "CANCELED") return run;
    if (run.status !== "CANCEL_REQUESTED") throw new Error("The run is no longer awaiting cancellation.");

    const lease = await tx.runLease.findFirst({
      where: {
        workspaceId: input.workspaceId,
        runId: input.runId,
        ownerId: input.runId,
        releasedAt: null,
      },
      select: { id: true, fencingToken: true },
    });
    if (!lease) throw new Error("Cancellation cannot finalize without the run's current fenced lease.");
    const fencingToken = lease.fencingToken.toString();
    const now = new Date();
    const reacquired = await tx.runLease.updateMany({
      where: {
        id: lease.id,
        workspaceId: input.workspaceId,
        runId: input.runId,
        ownerId: input.runId,
        fencingToken: lease.fencingToken,
        releasedAt: null,
      },
      data: { expiresAt: new Date(now.getTime() + 45 * 60_000) },
    });
    if (reacquired.count !== 1) throw new Error("Cancellation lost the run's fenced lease.");
    await requireCurrentRunLease(
      (args) => tx.runLease.updateMany(args),
      { workspaceId: input.workspaceId, runId: input.runId, fencingToken, now },
      "Cancellation lost the run's fenced lease before terminalization.",
    );

    const changed = await tx.workflowRun.updateMany({
      where: { id: input.runId, workspaceId: input.workspaceId, status: "CANCEL_REQUESTED", cancelRequestedAt: { not: null } },
      data: {
        status: "CANCELED",
        finishedAt: now,
        currentStepKey: null,
        failureCode: null,
        failureMessage: null,
        stateVersion: { increment: 1 },
      },
    });
    if (changed.count !== 1) throw new Error("The run changed while cancellation was finalizing.");
    await tx.workflowStep.updateMany({
      where: { runId: input.runId, status: { in: ["PENDING", "RUNNING", "WAITING"] } },
      data: { status: "CANCELED", finishedAt: now },
    });
    await tx.budgetReservation.updateMany({
      where: { runId: input.runId, status: { in: ["RESERVED", "EXCEEDED"] } },
      data: { status: "RELEASED", releasedAt: now },
    });
    if (isCustomerCreditsEnforced()) {
      const reservation = await tx.creditReservation.findUnique({
        where: { runId_runAttempt: { runId: input.runId, runAttempt: run.attempt } },
        select: { id: true, status: true },
      });
      if (reservation?.status === "HELD") {
        await releaseCreditReservation(tx, { workspaceId: input.workspaceId, reservationId: reservation.id, now });
      }
    }
    if (
      !(await releaseCurrentRunLease((args) => tx.runLease.updateMany(args), {
        workspaceId: input.workspaceId,
        runId: input.runId,
        fencingToken,
        now,
      }))
    ) {
      throw new Error("Cancellation lost the run's fenced lease before release.");
    }
    await tx.project.update({
      where: { id: run.projectId },
      data: {
        status: "FAILED",
        currentBlocker: "The latest run was canceled; no production change was completed",
        optimisticVersion: { increment: 1 },
      },
    });
    await tx.activityEvent.create({
      data: {
        workspaceId: input.workspaceId,
        projectId: run.projectId,
        runId: input.runId,
        type: "workflow.run.canceled",
        severity: "WARNING",
        message: `Run canceled after durable shutdown; ${input.deletedSandboxes.length} sandbox(es) removed and none remain.`,
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60_000),
      },
    });
    return tx.workflowRun.findUniqueOrThrow({ where: { id: input.runId } });
  });
}

export async function reconcileRunCancellation(workspaceId: string, runId: string): Promise<CancellationReconciliation> {
  const db = getDb();
  let run = await db.workflowRun.findFirst({ where: { id: runId, workspaceId } });
  if (!run) throw new Error("Run not found.");
  const cleanupRequired = cancellationNeedsSandboxCleanup(run.kind);
  if (run.status === "CANCELED") {
    return {
      run,
      durableExecutorsConfirmedStopped: true,
      sandboxCleanupRequired: cleanupRequired,
      sandboxCleanupConfirmed: true,
      deletedSandboxes: [],
      pendingReason: null,
    };
  }
  if (run.status !== "CANCEL_REQUESTED") throw new Error("The run is not awaiting cancellation.");

  const events = await db.outboxEvent.findMany({
    where: { workspaceId, aggregateType: "workflow_run", aggregateId: runId },
    select: { payload: true, attemptCount: true, publishedAt: true, lastError: true },
  });
  const executorRunIds = executorRunIdsFromPayloads(events.map((event) => event.payload));
  if (!executorDispatchIsAccountedFor(events, executorRunIds)) {
    const pendingReason = "Executor dispatch is not yet reconcilable; its durable run identifier may still be in flight.";
    await markCancellationPending(workspaceId, runId, pendingReason);
    run = (await db.workflowRun.findFirst({ where: { id: runId, workspaceId } })) ?? run;
    return {
      run,
      durableExecutorsConfirmedStopped: false,
      sandboxCleanupRequired: cleanupRequired,
      sandboxCleanupConfirmed: !cleanupRequired,
      deletedSandboxes: [],
      pendingReason,
    };
  }

  const executors = await cancelAndConfirmDurableExecutors(executorRunIds);
  if (!executors.confirmedStopped) {
    const pendingReason = "One or more durable executors have not confirmed a terminal state.";
    await markCancellationPending(workspaceId, runId, pendingReason);
    run = (await db.workflowRun.findFirst({ where: { id: runId, workspaceId } })) ?? run;
    return {
      run,
      durableExecutorsConfirmedStopped: false,
      sandboxCleanupRequired: cleanupRequired,
      sandboxCleanupConfirmed: !cleanupRequired,
      deletedSandboxes: [],
      pendingReason,
    };
  }

  let deletedSandboxes: string[] = [];
  let sandboxCleanupConfirmed = !cleanupRequired;
  if (cleanupRequired) {
    try {
      const daytonaKey = await getBackendDaytonaApiKey(workspaceId);
      const cleanup = await cleanupRunSandboxes(daytonaKey, runId);
      deletedSandboxes = cleanup.deleted;
      sandboxCleanupConfirmed = cleanup.confirmed;
      if (!cleanup.confirmed) {
        const pendingReason = `${cleanup.remaining.length} Daytona sandbox(es) still require cleanup confirmation.`;
        await markCancellationPending(workspaceId, runId, pendingReason);
        run = (await db.workflowRun.findFirst({ where: { id: runId, workspaceId } })) ?? run;
        return {
          run,
          durableExecutorsConfirmedStopped: true,
          sandboxCleanupRequired: true,
          sandboxCleanupConfirmed: false,
          deletedSandboxes,
          pendingReason,
        };
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Daytona cleanup failed.";
      const pendingReason = `Daytona cleanup could not be confirmed: ${redactSecrets(detail).slice(0, 700)}`;
      await markCancellationPending(workspaceId, runId, pendingReason);
      run = (await db.workflowRun.findFirst({ where: { id: runId, workspaceId } })) ?? run;
      return {
        run,
        durableExecutorsConfirmedStopped: true,
        sandboxCleanupRequired: true,
        sandboxCleanupConfirmed: false,
        deletedSandboxes,
        pendingReason,
      };
    }
  }

  if (
    !cancellationCanFinalize({
      durableExecutorsConfirmedStopped: executors.confirmedStopped,
      sandboxCleanupRequired: cleanupRequired,
      sandboxCleanupConfirmed,
    })
  ) {
    throw new Error("Cancellation cleanup proof is incomplete.");
  }
  run = await finalizeCanceledRun({ workspaceId, runId, deletedSandboxes });
  return {
    run,
    durableExecutorsConfirmedStopped: true,
    sandboxCleanupRequired: cleanupRequired,
    sandboxCleanupConfirmed: true,
    deletedSandboxes,
    pendingReason: null,
  };
}

export async function requestRunCancellation(
  workspaceId: string,
  runId: string,
  expectedStateVersion?: number,
  allowRecoveredVersion = false,
) {
  const db = getDb();
  const existing = await db.workflowRun.findFirst({ where: { id: runId, workspaceId } });
  if (!existing) throw new Error("Run not found.");
  if (existing.status === "CANCELED" || existing.status === "CANCEL_REQUESTED") {
    const exactVersion = expectedStateVersion === undefined || existing.stateVersion === expectedStateVersion;
    const recoveredVersion = allowRecoveredVersion
      && expectedStateVersion !== undefined
      && existing.stateVersion >= expectedStateVersion + 1;
    if (!exactVersion && !recoveredVersion) throw new Error("Run version conflict.");
    return reconcileRunCancellation(workspaceId, runId);
  }
  if (expectedStateVersion !== undefined && existing.stateVersion !== expectedStateVersion) {
    throw new Error("Run version conflict.");
  }
  if (existing.currentStepKey && irreversibleCancellationSteps.has(existing.currentStepKey)) {
    throw new Error("Cancellation is unavailable while an approved promotion is committing.");
  }
  if (!["QUEUED", "RUNNING", "WAITING_FOR_APPROVAL"].includes(existing.status)) {
    throw new Error("Only an active run can be canceled.");
  }
  const now = new Date();
  await db.$transaction(async (tx) => {
    const changed = await tx.workflowRun.updateMany({
      where: {
        id: runId,
        workspaceId,
        ...(expectedStateVersion !== undefined ? { stateVersion: expectedStateVersion } : {}),
        status: { in: ["QUEUED", "RUNNING", "WAITING_FOR_APPROVAL"] },
        OR: [{ currentStepKey: null }, { currentStepKey: { notIn: [...irreversibleCancellationSteps] } }],
      },
      data: {
        status: "CANCEL_REQUESTED",
        cancelRequestedAt: now,
        failureCode: "cancellation_pending",
        failureMessage: "Waiting for durable executor shutdown and sandbox cleanup confirmation.",
        stateVersion: { increment: 1 },
      },
    });
    if (changed.count !== 1) throw new Error("The run is no longer cancelable.");
    const retainedLease = await tx.runLease.updateMany({
      where: { workspaceId, runId, ownerId: runId, releasedAt: null },
      data: { expiresAt: new Date(now.getTime() + 2 * 60 * 60_000) },
    });
    if (retainedLease.count !== 1) throw new Error("Cancellation could not retain the run's fenced lease.");
    await tx.activityEvent.create({
      data: {
        workspaceId,
        projectId: existing.projectId,
        runId,
        type: "workflow.run.cancellation_requested",
        severity: "WARNING",
        message: "Cancellation requested; reservations and the fenced lease remain held until cleanup is confirmed.",
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60_000),
      },
    });
  });
  return reconcileRunCancellation(workspaceId, runId);
}

export async function reconcilePendingCancellations(limit = 50) {
  const db = getDb();
  const pending = await db.workflowRun.findMany({
    where: { status: "CANCEL_REQUESTED" },
    select: { id: true, workspaceId: true },
    orderBy: { cancelRequestedAt: "asc" },
    take: Math.min(Math.max(limit, 1), 100),
  });
  let canceled = 0;
  const failures: Array<{ runId: string; reason: string }> = [];
  for (const candidate of pending) {
    try {
      const result = await reconcileRunCancellation(candidate.workspaceId, candidate.id);
      if (result.run.status === "CANCELED") canceled += 1;
      else if (result.pendingReason) failures.push({ runId: candidate.id, reason: result.pendingReason });
    } catch (error) {
      failures.push({
        runId: candidate.id,
        reason: redactSecrets(error instanceof Error ? error.message : "Cancellation reconciliation failed.").slice(0, 300),
      });
    }
  }
  return { inspected: pending.length, canceled, pending: pending.length - canceled, failures };
}
