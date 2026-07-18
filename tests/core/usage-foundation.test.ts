import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ResolvedUsageQuerySchema, UsageReportSchema } from "@/contracts";
import {
  builderTokenScenario,
  createRunEstimateResponse,
  estimateConfidence,
  historicalTokenScenarios,
  nearestRankQuantile,
  selectEstimationBasis,
  type TokenSample,
} from "@/server/usage-estimator";
import { aggregateUsageReport, serializeRunUsage, type UsageEntryLike } from "@/server/usage-reporting";
import { getKimiPricingSnapshot, kimiUsageCostMicros } from "@/server/usage";

afterEach(() => vi.unstubAllEnvs());

const run = {
  kind: "BUILD",
  status: "SUCCEEDED",
  startedAt: new Date("2026-07-10T08:00:00.000Z"),
  finishedAt: new Date("2026-07-10T08:10:00.000Z"),
  project: { name: "Usage test" },
};

function entry(overrides: Partial<UsageEntryLike> = {}): UsageEntryLike {
  return {
    id: "usage-1",
    projectId: "project-1",
    runId: "run-1",
    provider: "KIMI",
    externalUsageId: "completion-1",
    model: "kimi-k2.7-code",
    operation: "builder_generation",
    inputUnits: 100n,
    outputUnits: 50n,
    inputRateMicrosPerMillion: 1_000_000n,
    outputRateMicrosPerMillion: 2_000_000n,
    pricingVersion: "2026-07-17.v1",
    costMicros: 200n,
    occurredAt: new Date("2026-07-10T08:05:00.000Z"),
    run,
    ...overrides,
  } as UsageEntryLike;
}

describe("usage-ledger pricing snapshots", () => {
  it("captures the configured Kimi rates and version used for integer cost calculation", () => {
    vi.stubEnv("KIMI_INPUT_COST_MICROS_PER_MILLION", "1000000");
    vi.stubEnv("KIMI_OUTPUT_COST_MICROS_PER_MILLION", "2000000");

    const snapshot = getKimiPricingSnapshot();
    expect(snapshot).toEqual({
      inputRateMicrosPerMillion: 1_000_000n,
      outputRateMicrosPerMillion: 2_000_000n,
      pricingVersion: "2026-07-17.v1",
    });
    expect(kimiUsageCostMicros({ inputUnits: 3, outputUnits: 4 }, snapshot)).toBe(11n);
  });

  it("backfills only model and never recomputes historical cost", () => {
    const migration = readFileSync(resolve(
      process.cwd(),
      "prisma/migrations/20260717120000_usage_reporting_foundation/migration.sql",
    ), "utf8");
    expect(migration).toContain(`"metadata"->>'model'`);
    expect(migration).toContain("'unknown'");
    expect(migration).toContain('ALTER COLUMN "model" SET NOT NULL');
    expect(migration).not.toMatch(/SET\s+"costMicros"/i);
  });
});

describe("usage serialization and aggregation", () => {
  it("rejects reporting ranges longer than one year", () => {
    expect(() => ResolvedUsageQuerySchema.parse({
      from: "2025-01-01T00:00:00.000Z",
      to: "2026-07-17T00:00:00.000Z",
      granularity: "day",
    })).toThrow(/one year/i);
  });

  it("serializes token and cost bigints as exact decimal strings", () => {
    const huge = BigInt(Number.MAX_SAFE_INTEGER) + 123n;
    const detail = serializeRunUsage([entry({ inputUnits: huge, outputUnits: 9n, costMicros: huge })]);

    expect(detail.usage).toMatchObject({
      inputTokens: huge.toString(),
      outputTokens: "9",
      totalTokens: (huge + 9n).toString(),
      costMicros: huge.toString(),
    });
    expect(detail.usage.inputUnits).toBeUndefined();
    expect(detail.usageEntries[0]).toMatchObject({
      inputTokens: huge.toString(),
      pricingSnapshotAvailable: true,
    });
  });

  it("aggregates exact totals, buckets, breakdowns, and completed runs", () => {
    const report = aggregateUsageReport({
      entries: [
        entry(),
        entry({
          id: "usage-2",
          externalUsageId: "completion-2",
          operation: "builder_repair",
          inputUnits: 25n,
          outputUnits: 75n,
          costMicros: 175n,
          occurredAt: new Date("2026-07-11T09:00:00.000Z"),
        }),
      ],
      query: {
        from: "2026-07-10T00:00:00.000Z",
        to: "2026-07-12T00:00:00.000Z",
        granularity: "day",
      },
      source: "actual",
      generatedAt: new Date("2026-07-12T00:00:00.000Z"),
    });

    expect(UsageReportSchema.parse(report)).toEqual(report);
    expect(report.totals).toEqual({
      providerCalls: 2,
      inputTokens: "125",
      outputTokens: "125",
      totalTokens: "250",
      costMicros: "375",
      completedRuns: 1,
      averageCostPerCompletedRunMicros: "375",
    });
    expect(report.buckets).toHaveLength(2);
    expect(report.breakdowns).toEqual(expect.arrayContaining([
      expect.objectContaining({ dimension: "model", value: "kimi-k2.7-code", costMicros: "375" }),
      expect.objectContaining({ dimension: "operation", value: "builder_repair", costMicros: "175" }),
    ]));
    expect(report.recentRuns[0]).toMatchObject({ runId: "run-1", totalTokens: "250" });
    expect(() => UsageReportSchema.parse({ ...report, unexpected: true })).toThrow();
  });

  it("excludes non-Kimi rows from report totals, buckets, breakdowns, and runs", () => {
    const report = aggregateUsageReport({
      entries: [
        entry(),
        entry({
          id: "vercel-same-run",
          provider: "VERCEL",
          externalUsageId: null,
          model: "vercel-approved-ceiling",
          operation: "deployment_ceiling",
          inputUnits: 9_000n,
          outputUnits: 1_000n,
          costMicros: 5_000_000n,
        }),
        entry({
          id: "vercel-only-run",
          provider: "VERCEL",
          runId: "run-2",
          externalUsageId: null,
          model: "vercel-approved-ceiling",
          operation: "deployment_ceiling",
          inputUnits: 20_000n,
          outputUnits: 0n,
          costMicros: 8_000_000n,
          occurredAt: new Date("2026-07-11T09:00:00.000Z"),
          run: { ...run, project: { name: "Vercel-only run" } },
        }),
      ],
      query: {
        from: "2026-07-10T00:00:00.000Z",
        to: "2026-07-12T00:00:00.000Z",
        granularity: "day",
      },
      source: "actual",
    });

    expect(report.totals).toEqual({
      providerCalls: 1,
      inputTokens: "100",
      outputTokens: "50",
      totalTokens: "150",
      costMicros: "200",
      completedRuns: 1,
      averageCostPerCompletedRunMicros: "200",
    });
    expect(report.buckets.map((bucket) => ({ calls: bucket.providerCalls, cost: bucket.costMicros }))).toEqual([
      { calls: 1, cost: "200" },
      { calls: 0, cost: "0" },
    ]);
    expect(report.breakdowns).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ value: "vercel-approved-ceiling" }),
      expect.objectContaining({ value: "deployment_ceiling" }),
    ]));
    expect(report.recentRuns).toHaveLength(1);
    expect(report.recentRuns[0]).toMatchObject({
      runId: "run-1",
      providerCalls: 1,
      totalTokens: "150",
      costMicros: "200",
      models: ["kimi-k2.7-code"],
    });
  });
});

describe("run estimation", () => {
  const samples: TokenSample[] = [1n, 2n, 3n, 4n, 5n].map((value) => ({
    inputTokens: value,
    outputTokens: value * 10n,
  }));

  it("uses nearest-rank p25, p50, and p90 quantiles", () => {
    expect(nearestRankQuantile([5n, 1n, 4n, 2n, 3n], 0.25)).toBe(2n);
    expect(historicalTokenScenarios(samples)).toEqual({
      low: { inputTokens: 2n, outputTokens: 20n, totalTokens: 22n },
      expected: { inputTokens: 3n, outputTokens: 30n, totalTokens: 33n },
      high: { inputTokens: 5n, outputTokens: 50n, totalTokens: 55n },
    });
  });

  it("selects whole nearest-rank scenarios when input and output usage are inversely correlated", () => {
    const inverseSamples: TokenSample[] = [
      { inputTokens: 10n, outputTokens: 100n },
      { inputTokens: 20n, outputTokens: 80n },
      { inputTokens: 30n, outputTokens: 60n },
      { inputTokens: 40n, outputTokens: 40n },
      { inputTokens: 50n, outputTokens: 20n },
    ];

    expect(historicalTokenScenarios(inverseSamples)).toEqual({
      low: { inputTokens: 40n, outputTokens: 40n, totalTokens: 80n },
      expected: { inputTokens: 30n, outputTokens: 60n, totalTokens: 90n },
      high: { inputTokens: 10n, outputTokens: 100n, totalTokens: 110n },
    });
  });

  it("selects project, workspace, then cold-start fallback with plan confidence thresholds", () => {
    expect(selectEstimationBasis(samples, samples).method).toBe("project_history");
    expect(selectEstimationBasis(samples.slice(0, 4), samples).method).toBe("workspace_history");
    expect(selectEstimationBasis(samples.slice(0, 4), samples.slice(0, 4)).method).toBe("cold_start");
    expect([estimateConfidence(4), estimateConfidence(5), estimateConfidence(20)]).toEqual(["low", "medium", "high"]);
  });

  it("implements the multi-turn cold-start formula", () => {
    expect(builderTokenScenario({
      turns: 3,
      initialPromptTokens: 100n,
      generatedTokensPerTurn: 10n,
      toolResultTokensPerTurn: 5n,
    })).toEqual({ inputTokens: 345n, outputTokens: 30n, totalTokens: 375n });
  });

  it("keeps credits, provider estimates, actuals, and the authorized ceiling separate", () => {
    vi.stubEnv("KIMI_INPUT_COST_MICROS_PER_MILLION", "1000000");
    vi.stubEnv("KIMI_OUTPUT_COST_MICROS_PER_MILLION", "2000000");
    const scenario = { inputTokens: 3n, outputTokens: 4n, totalTokens: 7n };
    const estimate = createRunEstimateResponse({
      projectId: "project-1",
      kind: "build",
      model: "kimi-k2.7-code",
      method: "project_history",
      samples,
      scenarios: { low: scenario, expected: scenario, high: scenario },
      maxCostMicrosPerRun: 9_000_000n,
      assumptions: ["Historical scenario."],
      estimatedAt: new Date("2026-07-17T00:00:00.000Z"),
    });

    expect(estimate.providerCostMicros.expected).toBe("11");
    expect(estimate.creditQuote).toMatchObject({ operation: "build", credits: "300" });
    expect(estimate.authorizedProviderCostCeilingMicros).toBe("9000000");
    expect(estimate).not.toHaveProperty("actualCostMicros");
    expect(estimate.scenarioOnly).toBe(true);
  });
});
