import { cancelRun, readIdempotent, serializeDemoRun, writeIdempotent } from "@/workflows/demo-store";
import { isDemoMode } from "@/server/env";
import {
  claimPublishedIdempotencyReceipt,
  completePublishedIdempotencyReceipt,
  secureIdempotencyFingerprint,
} from "@/server/published-idempotency";
import { handleRouteError, HttpError, mutationContext, ok, requestId } from "@/workflows/http";
import { serializeRun } from "@/workflows/production-run";
import { requestRunCancellation } from "@/workflows/cancellation";

type Context = { params: Promise<{ runId: string }> };

export async function POST(request: Request, { params }: Context) {
  const id = requestId(request);
  try {
    const context = await mutationContext(request, { requireVersion: true });
    const { runId } = await params;
    if (!isDemoMode()) {
      const operation = "run.cancel";
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
        return ok(claim.outcome.response, context.requestId);
      }
      if (claim.kind === "in_progress") throw new HttpError("conflict", "This cancellation request is already in progress.", 409, true);
      try {
        const cancellation = await requestRunCancellation(
          context.owner.workspaceId,
          runId,
          context.expectedVersion!,
          claim.claim.fencingVersion > 1,
        );
        const result = {
          ...serializeRun(cancellation.run),
          deletedSandboxes: cancellation.deletedSandboxes,
          cancellation: {
            durableExecutorsConfirmedStopped: cancellation.durableExecutorsConfirmedStopped,
            sandboxCleanupRequired: cancellation.sandboxCleanupRequired,
            sandboxCleanupConfirmed: cancellation.sandboxCleanupConfirmed,
            pendingReason: cancellation.pendingReason,
          },
        };
        await completePublishedIdempotencyReceipt({
          workspaceId: context.owner.workspaceId,
          claim: claim.claim,
          operation,
          requestFingerprint,
          outcome: { ok: true, response: result },
        });
        return ok(result, context.requestId, { status: cancellation.run.status === "CANCELED" ? 200 : 202 });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Cancellation failed.";
        if (message === "Run not found.") throw new HttpError("not_found", message, 404);
        if (/version conflict/i.test(message)) throw new HttpError("precondition_failed", message, 412);
        if (/promotion|active run|cancelable|awaiting cancellation/i.test(message)) {
          throw new HttpError("conflict", message, 409);
        }
        throw error;
      }
    }
    const cached = readIdempotent<unknown>(context.idempotencyKey);
    if (cached) return ok(cached, context.requestId);
    const run = cancelRun(runId, context.expectedVersion!);
    const serialized = serializeDemoRun(run);
    writeIdempotent(context.idempotencyKey, serialized);
    return ok(serialized, context.requestId, { status: 202 });
  } catch (error) {
    return handleRouteError(error, id);
  }
}
