import { describe, expect, it, vi } from "vitest";

import {
  cancelAndConfirmDurableExecutors,
  cancellationCanFinalize,
  cancellationNeedsSandboxCleanup,
  executorDispatchIsAccountedFor,
  executorRunIdsFromPayloads,
  type ExecutorResolver,
} from "@/workflows/cancellation";

function executorHandle(input: {
  exists?: boolean;
  before?: string;
  after?: string;
  cancelError?: Error;
}) {
  let canceled = false;
  const cancel = vi.fn(async () => {
    if (input.cancelError) throw input.cancelError;
    canceled = true;
  });
  return {
    cancel,
    exists: Promise.resolve(input.exists ?? true),
    get status() {
      return Promise.resolve(canceled ? input.after ?? "cancelled" : input.before ?? "running");
    },
  };
}

describe("durable cancellation reconciliation", () => {
  it("deduplicates every persisted executor identifier", () => {
    expect(
      executorRunIdsFromPayloads([
        { executorRunId: "exec-1" },
        { executorRunIds: ["exec-1", "exec-2", null] },
        null,
      ]),
    ).toEqual(["exec-1", "exec-2"]);
  });

  it("requires Daytona cleanup only for build-capable runs", () => {
    expect(cancellationNeedsSandboxCleanup("BUILD")).toBe(true);
    expect(cancellationNeedsSandboxCleanup("POLISH")).toBe(true);
    expect(cancellationNeedsSandboxCleanup("RESEARCH")).toBe(false);
    expect(cancellationNeedsSandboxCleanup("RELEASE")).toBe(false);
  });

  it("fails closed for an unaccounted dispatch and incomplete cleanup proof", () => {
    expect(executorDispatchIsAccountedFor([], [])).toBe(false);
    expect(
      executorDispatchIsAccountedFor(
        [{ attemptCount: 1, publishedAt: null, lastError: "workflow start timed out" }],
        [],
      ),
    ).toBe(false);
    expect(
      executorDispatchIsAccountedFor(
        [{ attemptCount: 0, publishedAt: null, lastError: null }],
        [],
      ),
    ).toBe(true);
    expect(
      executorDispatchIsAccountedFor(
        [{ attemptCount: 2, publishedAt: new Date(), lastError: "unresolved_executor_start:canonical_cancel_requested" }],
        [],
      ),
    ).toBe(false);
    expect(
      executorDispatchIsAccountedFor(
        [{ attemptCount: 1, publishedAt: new Date(), lastError: "canonical_cancel_requested" }],
        [],
      ),
    ).toBe(true);
    expect(
      cancellationCanFinalize({
        durableExecutorsConfirmedStopped: true,
        sandboxCleanupRequired: true,
        sandboxCleanupConfirmed: false,
      }),
    ).toBe(false);
    expect(
      cancellationCanFinalize({
        durableExecutorsConfirmedStopped: true,
        sandboxCleanupRequired: true,
        sandboxCleanupConfirmed: true,
      }),
    ).toBe(true);
  });

  it("does not treat cancel acknowledgement as terminal without a terminal readback", async () => {
    const handle = executorHandle({ after: "running" });
    const resolve: ExecutorResolver = () => handle;

    await expect(cancelAndConfirmDurableExecutors(["exec-1"], resolve)).resolves.toEqual({
      confirmedStopped: false,
      failures: ["exec-1"],
      statuses: [{ runId: "exec-1", status: "running" }],
    });
    expect(handle.cancel).toHaveBeenCalledOnce();
  });

  it("confirms terminal, missing, and successfully canceled executors", async () => {
    const handles = {
      terminal: executorHandle({ before: "completed" }),
      missing: executorHandle({ exists: false }),
      active: executorHandle({ before: "running", after: "cancelled" }),
    };
    const resolve: ExecutorResolver = (runId) => handles[runId as keyof typeof handles];

    const result = await cancelAndConfirmDurableExecutors(["terminal", "missing", "active"], resolve);

    expect(result.confirmedStopped).toBe(true);
    expect(result.failures).toEqual([]);
    expect(result.statuses).toEqual([
      { runId: "terminal", status: "completed" },
      { runId: "missing", status: "missing" },
      { runId: "active", status: "cancelled" },
    ]);
    expect(handles.terminal.cancel).not.toHaveBeenCalled();
    expect(handles.missing.cancel).not.toHaveBeenCalled();
    expect(handles.active.cancel).toHaveBeenCalledOnce();
  });

  it("keeps reconciliation pending when the executor service is unavailable", async () => {
    const resolve: ExecutorResolver = () => executorHandle({ cancelError: new Error("provider unavailable") });
    const result = await cancelAndConfirmDurableExecutors(["exec-1"], resolve);

    expect(result.confirmedStopped).toBe(false);
    expect(result.failures).toEqual(["exec-1"]);
    expect(result.statuses).toEqual([{ runId: "exec-1", status: "unavailable" }]);
  });
});
