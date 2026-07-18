import { describe, expect, it, vi } from "vitest";

import {
  parseWorkflowFencingToken,
  releaseCurrentRunLease,
  renewCurrentRunLease,
  requireCurrentRunLease,
  StaleWorkflowLeaseError,
} from "@/workflows/lease-fencing";

describe("workflow lease fencing", () => {
  it("accepts only the exact current token and rejects a stale durable attempt", async () => {
    const currentToken = 9n;
    const updateMany = vi.fn(async (args: { where: { fencingToken: bigint } }) => ({
      count: args.where.fencingToken === currentToken ? 1 : 0,
    }));

    await expect(
      requireCurrentRunLease(updateMany, {
        workspaceId: "workspace-1",
        runId: "run-1",
        fencingToken: "8",
        now: new Date("2026-07-11T00:00:00.000Z"),
      }),
    ).rejects.toBeInstanceOf(StaleWorkflowLeaseError);

    await expect(
      requireCurrentRunLease(updateMany, {
        workspaceId: "workspace-1",
        runId: "run-1",
        fencingToken: "9",
        now: new Date("2026-07-11T00:00:00.000Z"),
      }),
    ).resolves.toBeUndefined();

    expect(updateMany).toHaveBeenLastCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        workspaceId: "workspace-1",
        runId: "run-1",
        ownerId: "run-1",
        fencingToken: 9n,
        releasedAt: null,
      }),
    }));
  });

  it("does not release a replacement lease with an older token", async () => {
    const updateMany = vi.fn(async (args: { where: { fencingToken: bigint } }) => ({
      count: args.where.fencingToken === 14n ? 1 : 0,
    }));
    const input = {
      workspaceId: "workspace-1",
      runId: "run-1",
      now: new Date("2026-07-11T00:00:00.000Z"),
    };

    await expect(releaseCurrentRunLease(updateMany, { ...input, fencingToken: "13" })).resolves.toBe(false);
    await expect(releaseCurrentRunLease(updateMany, { ...input, fencingToken: "14" })).resolves.toBe(true);
  });

  it("uses a decimal string so workflow serialization never loses bigint precision", async () => {
    expect(parseWorkflowFencingToken("900719925474099312345")).toBe(900719925474099312345n);
    expect(() => parseWorkflowFencingToken("0")).toThrow(StaleWorkflowLeaseError);
    expect(() => parseWorkflowFencingToken("1.5")).toThrow(StaleWorkflowLeaseError);

    const updateMany = vi.fn(async () => ({ count: 0 }));
    await expect(
      renewCurrentRunLease(updateMany, { workspaceId: "w", runId: "r", fencingToken: "not-a-token" }),
    ).rejects.toBeInstanceOf(StaleWorkflowLeaseError);
    expect(updateMany).not.toHaveBeenCalled();
  });
});
