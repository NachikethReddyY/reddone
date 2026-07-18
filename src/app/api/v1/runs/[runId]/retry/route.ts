import { reserveCredits } from "@/server/credits";
import { getDb } from "@/server/db";
import { isCustomerCreditsEnforced, isDemoMode } from "@/server/env";
import {
  claimPublishedIdempotencyReceipt,
  completePublishedIdempotencyReceipt,
  secureIdempotencyFingerprint,
} from "@/server/published-idempotency";
import { withSerializableTransaction } from "@/server/transactions";
import { getRun, readIdempotent, serializeDemoRun, startRun, writeIdempotent } from "@/workflows/demo-store";
import { handleRouteError, HttpError, mutationContext, ok, requestId } from "@/workflows/http";
import { createProductionRun, dispatchProductionRun, serializeRun } from "@/workflows/production-run";

type Context = { params: Promise<{ runId: string }> };

export async function POST(request: Request, { params }: Context) {
  const id = requestId(request);
  try {
    const context = await mutationContext(request, { requireVersion: true });
    const { runId } = await params;
    if (!isDemoMode()) {
      const operation = "run.retry";
      const requestFingerprint = secureIdempotencyFingerprint(operation, {
        runId,
        expectedStateVersion: context.expectedVersion,
      });
      const claim = await claimPublishedIdempotencyReceipt({
        workspaceId: context.owner.workspaceId,
        idempotencyKey: context.idempotencyKey,
        operation,
        requestFingerprint,
        leaseMs: 10 * 60_000,
      });
      if (claim.kind === "replay") {
        if (!claim.outcome.ok) {
          throw new HttpError(claim.outcome.error.code, claim.outcome.error.message, claim.outcome.error.status, claim.outcome.error.retryable);
        }
        return ok(claim.outcome.response, context.requestId, { status: 202 });
      }
      if (claim.kind === "in_progress") throw new HttpError("conflict", "This retry request is already in progress.", 409, true);
      const respond = async (result: unknown) => {
        await completePublishedIdempotencyReceipt({
          workspaceId: context.owner.workspaceId,
          claim: claim.claim,
          operation,
          requestFingerprint,
          outcome: { ok: true, response: result },
        });
        return ok(result, context.requestId, { status: 202 });
      };
      const previous = await getDb().workflowRun.findFirst({
        where: { id: runId, workspaceId: context.owner.workspaceId },
      });
      if (!previous) throw new HttpError("not_found", "Run not found.", 404);
      const recoveredReleaseRetry =
        claim.claim.fencingVersion > 1
        && (previous.kind === "RELEASE" || previous.kind === "ROLLBACK")
        && previous.status === "QUEUED"
        && previous.stateVersion === context.expectedVersion! + 1;
      if (previous.stateVersion !== context.expectedVersion && !recoveredReleaseRetry) {
        throw new HttpError("precondition_failed", "Run version conflict.", 412);
      }
      if ((previous.kind === "RELEASE" || previous.kind === "ROLLBACK") && previous.status === "QUEUED") {
        const executorRunId = await dispatchProductionRun(context.owner.workspaceId, previous.id);
        return respond({ ...serializeRun(previous), executorRunId, dispatchStatus: executorRunId ? "dispatched" : "pending", replayed: true });
      }
      if (previous.status !== "FAILED" && previous.status !== "CANCELED") {
        throw new HttpError("conflict", "Only failed or canceled runs can be retried.", 409);
      }
      if (previous.kind === "RELEASE" || previous.kind === "ROLLBACK") {
        const retried = await withSerializableTransaction(getDb(), async (tx) => {
          const run = await tx.workflowRun.update({
            where: { id: previous.id, stateVersion: context.expectedVersion! },
            data: {
              status: "QUEUED",
              attempt: { increment: 1 },
              cancelRequestedAt: null,
              startedAt: null,
              finishedAt: null,
              currentStepKey: null,
              failureCode: null,
              failureMessage: null,
              stateVersion: { increment: 1 },
            },
          });
          if (isCustomerCreditsEnforced()) {
            await reserveCredits(tx, {
              workspaceId: context.owner.workspaceId,
              projectId: run.projectId,
              runId: run.id,
              runAttempt: run.attempt,
              operation: run.kind === "ROLLBACK" ? "rollback" : "release",
            });
          }
          await tx.workflowStep.updateMany({
            where: { runId: run.id },
            data: { status: "PENDING", attempt: { increment: 1 }, startedAt: null, finishedAt: null, failureCode: null, failureMessage: null },
          });
          await tx.budgetReservation.updateMany({
            where: { runId: run.id },
            data: { status: "RESERVED", releasedAt: null, committedAt: null, actualMicros: null, expiresAt: new Date(Date.now() + 60 * 60_000) },
          });
          const lease = await tx.runLease.findUnique({
            where: { workspaceId_resourceKey: { workspaceId: context.owner.workspaceId, resourceKey: `release:${run.projectId}` } },
          });
          if (!lease) throw new Error("Release retry lease is missing.");
          await tx.runLease.update({
            where: { id: lease.id },
            data: { runId: run.id, ownerId: run.id, fencingToken: { increment: 1 }, acquiredAt: new Date(), expiresAt: new Date(Date.now() + 45 * 60_000), releasedAt: null },
          });
          const outbox = await tx.outboxEvent.findFirst({
            where: { workspaceId: context.owner.workspaceId, aggregateType: "workflow_run", aggregateId: run.id },
            orderBy: { createdAt: "desc" },
          });
          if (!outbox) throw new Error("Release retry outbox event is missing.");
          await tx.outboxEvent.update({
            where: { id: outbox.id },
            data: { publishedAt: null, availableAt: new Date(), lastError: null },
          });
          await tx.project.update({
            where: { id: run.projectId },
            data: { status: "BUILDING", currentBlocker: "Release reconciliation retry in progress", optimisticVersion: { increment: 1 } },
          });
          return run;
        }, { timeoutMs: 15_000 });
        const executorRunId = await dispatchProductionRun(context.owner.workspaceId, retried.id);
        return respond({ ...serializeRun(retried), executorRunId, dispatchStatus: executorRunId ? "dispatched" : "pending", replayed: false });
      }
      if (previous.kind !== "RESEARCH" && previous.kind !== "BUILD" && previous.kind !== "POLISH") {
        throw new HttpError("conflict", "This run type cannot be retried from this endpoint.", 409);
      }
      const created = await createProductionRun({
        workspaceId: context.owner.workspaceId,
        projectId: previous.projectId,
        kind: previous.kind.toLowerCase() as "research" | "build" | "polish",
        model: previous.model as "zai-org/glm-5.2" | "moonshotai/kimi-k2.7-code",
        ...(previous.specVersionId ? { specVersionId: previous.specVersionId } : {}),
        budgetCeilingMicros: Number(previous.budgetCeilingMicros),
        idempotencyKey: context.idempotencyKey,
        parentRunId: previous.id,
        expectedParentRunVersion: context.expectedVersion!,
        attempt: previous.attempt + 1,
      });
      const executorRunId = await dispatchProductionRun(context.owner.workspaceId, created.run.id);
      return respond({ ...serializeRun(created.run), executorRunId, dispatchStatus: executorRunId ? "dispatched" : "pending", replayed: created.replayed });
    }
    const cached = readIdempotent<unknown>(context.idempotencyKey);
    if (cached) return ok(cached, context.requestId);
    const previous = getRun(runId);
    if (!previous) throw new HttpError("not_found", "Run not found.", 404);
    if (previous.version !== context.expectedVersion) throw new HttpError("precondition_failed", "Run version conflict.", 412);
    if (!(["failed", "canceled"] as const).includes(previous.status as "failed" | "canceled")) {
      throw new HttpError("conflict", "Only failed or canceled runs can be retried.", 409);
    }
    const run = startRun(previous.projectId, previous.kind);
    const serialized = serializeDemoRun(run);
    writeIdempotent(context.idempotencyKey, serialized);
    return ok(serialized, context.requestId, { status: 202 });
  } catch (error) {
    return handleRouteError(error, id);
  }
}
