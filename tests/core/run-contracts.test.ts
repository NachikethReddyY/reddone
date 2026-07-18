import { describe, expect, it } from "vitest";

import { RunDetailSchema, RunEventPageSchema, RunStateSchema } from "@/contracts";
import { serializeDemoRunUsage } from "@/server/usage-reporting";
import { getRun, resetDemoStore, serializeDemoRun, serializeDemoRunState } from "@/workflows/demo-store";
import { serializeRunEventPage, serializeRunState } from "@/workflows/run-serialization";

describe("run response contracts", () => {
  it("serializes a persisted run through the strict RunState contract", () => {
    const createdAt = new Date("2026-07-11T01:00:00.000Z");
    const updatedAt = new Date("2026-07-11T01:01:30.000Z");
    const serialized = serializeRunState({
      id: "run-live-1",
      projectId: "project-live-1",
      kind: "BUILD",
      status: "RUNNING",
      stateVersion: 3,
      attempt: 2,
      currentStepKey: "build.verifier",
      budgetCeilingMicros: 12_000_000n,
      reservedMicros: 12_000_000n,
      actualCostMicros: 4_100_000n,
      cancelRequestedAt: null,
      startedAt: createdAt,
      finishedAt: null,
      createdAt,
      updatedAt,
      steps: [
        {
          id: "step-live-1",
          key: "verifier",
          label: "Fresh sandbox verification",
          status: "RUNNING",
          attempt: 2,
          startedAt: updatedAt,
          finishedAt: null,
          failureMessage: null,
        },
      ],
    });

    expect(RunStateSchema.parse(serialized)).toEqual(serialized);
    expect(serialized).toMatchObject({
      kind: "build",
      status: "running",
      attempt: 2,
      budgetCeilingMicros: 12_000_000,
      steps: [{ status: "running", summary: null }],
    });
  });

  it("normalizes the demo run to the same strict state contract before adding UI detail", () => {
    resetDemoStore();
    const run = getRun("run_research_complete");
    expect(run).not.toBeNull();

    const state = serializeDemoRunState(run!);
    const detail = serializeDemoRun(run!);

    expect(RunStateSchema.parse(state)).toEqual(state);
    expect(detail).toMatchObject(state);
    expect(detail).toMatchObject({ mode: "demo", progress: 100, previewUrl: null });
    expect(state.actualCostMicros).toBe(830_000);
    expect(serializeDemoRunState({ ...run!, status: "awaiting_approval" }).status).toBe("waiting_for_approval");
  });

  it("validates aggregate and per-call usage in the strict run detail contract", () => {
    resetDemoStore();
    const run = getRun("run_research_complete")!;
    const detail = { ...serializeDemoRun(run), ...serializeDemoRunUsage(run) };

    expect(RunDetailSchema.parse(detail)).toEqual(detail);
    expect(detail.usage).toMatchObject({ providerCalls: 1, pricingSnapshotsComplete: false });
    expect(detail.usageEntries[0]).toMatchObject({
      provider: "kimi",
      model: "kimi-k2.6",
      operation: "simulated_research",
      pricingSnapshotAvailable: false,
    });
    expect(() => RunDetailSchema.parse({ ...detail, adHoc: true })).toThrow();
  });

  it("fails closed when persisted money cannot be represented safely in the JSON contract", () => {
    const timestamp = new Date("2026-07-11T01:00:00.000Z");
    expect(() => serializeRunState({
      id: "run-overflow",
      projectId: "project-live-1",
      kind: "BUILD",
      status: "QUEUED",
      stateVersion: 0,
      attempt: 1,
      currentStepKey: null,
      budgetCeilingMicros: BigInt(Number.MAX_SAFE_INTEGER) + 1n,
      reservedMicros: 0n,
      actualCostMicros: 0n,
      cancelRequestedAt: null,
      startedAt: null,
      finishedAt: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    })).toThrow();
  });
});

describe("run event page contract", () => {
  it("normalizes persisted bigint cursors and enum severity through RunEventPageSchema", () => {
    const page = serializeRunEventPage({
      items: [
        {
          id: "activity-live-1",
          runId: "run-live-1",
          projectId: "project-live-1",
          sequence: 42n,
          type: "workflow.run.started",
          severity: "INFO",
          message: "Build workflow started.",
          data: { mode: "live" },
          createdAt: new Date("2026-07-11T01:00:00.000Z"),
        },
      ],
      nextCursor: "42",
      retentionStartsAt: new Date("2026-06-11T01:00:00.000Z"),
    });

    expect(RunEventPageSchema.parse(page)).toEqual(page);
    expect(page.items[0]).toMatchObject({ sequence: 42, severity: "info", runId: "run-live-1" });
    expect(page.nextCursor).toBe("42");
  });

  it("normalizes demo event fields into the identical event-page shape", () => {
    const page = serializeRunEventPage({
      items: [
        {
          id: "run-demo-1:1",
          runId: "run-demo-1",
          projectId: "project-demo-1",
          sequence: 1,
          type: "verification.passed",
          severity: "success",
          message: "All verifier gates passed.",
          data: {},
          createdAt: "2026-07-11T01:00:00.000Z",
        },
      ],
      nextCursor: "1",
      retentionStartsAt: "2026-06-11T01:00:00.000Z",
    });

    expect(RunEventPageSchema.parse(page)).toEqual(page);
    expect(page.items[0]?.projectId).toBe("project-demo-1");
  });

  it("rejects an unsafe bigint cursor instead of losing precision", () => {
    expect(() => serializeRunEventPage({
      items: [
        {
          id: "activity-overflow",
          runId: "run-live-1",
          projectId: "project-live-1",
          sequence: BigInt(Number.MAX_SAFE_INTEGER) + 1n,
          type: "workflow.run.started",
          severity: "INFO",
          message: "Build workflow started.",
          data: {},
          createdAt: "2026-07-11T01:00:00.000Z",
        },
      ],
      nextCursor: null,
      retentionStartsAt: "2026-06-11T01:00:00.000Z",
    })).toThrow(/safe cursor range/i);
  });
});
