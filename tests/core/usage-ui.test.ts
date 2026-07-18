import { afterEach, describe, expect, it, vi } from "vitest";

import type { UsageReport } from "@/contracts";
import { createUsageChartGeometry } from "@/features/usage/usage-chart-geometry";
import {
  applyUsageRangePreset,
  buildUsagePageSearchParams,
  buildUsageSearchParams,
  createUsageFilters,
  formatBucketDate,
  formatMicrodollars,
  formatMicrodollarsAccessible,
  formatTokens,
  parseUsagePageSearchParams,
  validateUsageFilters,
} from "@/features/usage/usage-format";
import { fetchUsageReport } from "@/features/usage/usage-queries";

const buckets: UsageReport["buckets"] = [
  { start: "2026-07-01T00:00:00.000Z", end: "2026-07-02T00:00:00.000Z", providerCalls: 1, inputTokens: "1000", outputTokens: "500", totalTokens: "1500", costMicros: "250000" },
  { start: "2026-07-02T00:00:00.000Z", end: "2026-07-03T00:00:00.000Z", providerCalls: 2, inputTokens: "2000", outputTokens: "1250", totalTokens: "3250", costMicros: "750000" },
  { start: "2026-07-03T00:00:00.000Z", end: "2026-07-04T00:00:00.000Z", providerCalls: 3, inputTokens: "4000", outputTokens: "2000", totalTokens: "6000", costMicros: "1500000" },
];

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("usage formatting", () => {
  it("formats microdollars exactly and preserves precise accessible wording", () => {
    expect(formatMicrodollars("0")).toBe("$0.00");
    expect(formatMicrodollars("1234567")).toBe("$1.234567");
    expect(formatMicrodollarsAccessible("1234567")).toBe("1.234567 US dollars");
    expect(formatTokens("9007199254740993")).toContain("9,007,199,254,740,993");
  });

  it("builds bounded, exclusive-end usage queries with all supported filters", () => {
    const base = createUsageFilters(new Date("2026-07-17T18:00:00.000Z"));
    const filters = { ...base, projectId: "project_1", runKind: "build" as const, operation: "kimi_build", model: "kimi-k2.7-code" };
    const query = buildUsageSearchParams(filters);
    expect(query.get("from")).toBe("2026-06-18T00:00:00.000Z");
    expect(query.get("to")).toBe("2026-07-18T00:00:00.000Z");
    expect(query.get("projectId")).toBe("project_1");
    expect(query.get("runKind")).toBe("build");
    expect(query.get("operation")).toBe("kimi_build");
    expect(query.get("model")).toBe("kimi-k2.7-code");
    expect(validateUsageFilters({ ...filters, from: "2025-01-01" })).toBe("Usage ranges cannot exceed one year.");
    expect(applyUsageRangePreset({ ...base, granularity: "week" }, "7d", new Date("2026-07-17T18:00:00.000Z")).granularity).toBe("week");
  });

  it("strictly parses and serializes shareable page filters while preserving unrelated parameters", () => {
    const now = new Date("2026-07-17T18:00:00.000Z");
    const filters = parseUsagePageSearchParams(new URLSearchParams("from=2026-07-01&to=2026-07-17&granularity=week&projectId=project_1&runKind=build&operation=kimi_build&model=kimi-k2.7-code&preset=custom"), now);
    expect(filters).toEqual({
      preset: "custom",
      from: "2026-07-01",
      to: "2026-07-17",
      granularity: "week",
      projectId: "project_1",
      runKind: "build",
      operation: "kimi_build",
      model: "kimi-k2.7-code",
    });

    const pageQuery = buildUsagePageSearchParams(filters, new URLSearchParams("continue=sign-in&granularity=day"));
    expect(pageQuery.get("continue")).toBe("sign-in");
    expect(pageQuery.get("to")).toBe("2026-07-17");
    expect(pageQuery.get("granularity")).toBe("week");
    expect(buildUsageSearchParams(filters).get("to")).toBe("2026-07-18T00:00:00.000Z");
  });

  it("falls back safely for duplicate, invalid, and overlong page values without dropping valid filters", () => {
    const now = new Date("2026-07-17T18:00:00.000Z");
    const defaults = createUsageFilters(now);
    const filters = parseUsagePageSearchParams(new URLSearchParams("from=2025-01-01&to=2026-07-17&granularity=week&granularity=day&projectId=project_1&runKind=unknown&operation=kimi_build"), now);
    expect(filters.from).toBe(defaults.from);
    expect(filters.to).toBe(defaults.to);
    expect(filters.granularity).toBe("day");
    expect(filters.projectId).toBe("project_1");
    expect(filters.runKind).toBe("");
    expect(filters.operation).toBe("kimi_build");
    expect(parseUsagePageSearchParams(new URLSearchParams("granularity=week"), now).granularity).toBe("week");
    expect(parseUsagePageSearchParams(new URLSearchParams("from=2026-02-30&to=2026-03-01"), now)).toMatchObject(defaults);
  });

  it("aligns weekly labels to UTC Mondays while leaving daily labels unchanged", () => {
    expect(formatBucketDate("2026-07-17T23:59:59.999Z", "week", true)).toBe(formatBucketDate("2026-07-13T00:00:00.000Z", "week", true));
    expect(formatBucketDate("2026-07-12T00:00:00.000Z", "week", true)).toBe(formatBucketDate("2026-07-06T00:00:00.000Z", "week", true));
    expect(formatBucketDate("2026-07-17T00:00:00.000Z", "day", true)).not.toBe(formatBucketDate("2026-07-13T00:00:00.000Z", "day", true));
  });
});

describe("usage response errors", () => {
  const filters = createUsageFilters(new Date("2026-07-17T18:00:00.000Z"));

  it("uses safe messages for non-JSON and contract-invalid responses", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("bad gateway", { status: 502 })));
    await expect(fetchUsageReport(filters)).rejects.toThrow("Usage request failed (502).");

    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ data: { source: "simulated" } }), { status: 200 })));
    await expect(fetchUsageReport(filters)).rejects.toThrow("Usage response was invalid.");
  });

  it("preserves a valid API error message without exposing schema diagnostics", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { message: "Usage is temporarily unavailable." } }), { status: 503 })));
    await expect(fetchUsageReport(filters)).rejects.toThrow("Usage is temporarily unavailable.");

    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ data: { buckets: "invalid" } }), { status: 200 })));
    const error = await fetchUsageReport(filters).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("Usage response was invalid.");
    expect((error as Error).message).not.toMatch(/Zod|invalid_type|buckets/);
  });
});

describe("usage chart geometry", () => {
  it("uses one zero-based scale and aligns both token series to the same bucket positions", () => {
    const geometry = createUsageChartGeometry(buckets, "tokens");
    expect(geometry.series).toHaveLength(2);
    expect(geometry.yTicks[0]?.value).toBe(0);
    expect(geometry.yTicks[0]?.y).toBe(geometry.plotBottom);
    expect(geometry.series[0]?.points.map((point) => point.x)).toEqual(geometry.series[1]?.points.map((point) => point.x));
    expect(geometry.series[0]?.dashed).toBe(false);
    expect(geometry.series[1]?.dashed).toBe(true);
    expect(geometry.series[0]?.marker).toBe("circle");
    expect(geometry.series[1]?.marker).toBe("diamond");
    expect(geometry.hitZones).toHaveLength(buckets.length);
    expect(geometry.series.every((series) => series.points.every((point) => point.y >= geometry.plotTop && point.y <= geometry.plotBottom))).toBe(true);
  });

  it("produces one cost series with finite responsive SVG geometry", () => {
    const geometry = createUsageChartGeometry(buckets, "cost");
    expect(geometry.series.map((series) => series.key)).toEqual(["cost"]);
    expect(geometry.series[0]?.path).toMatch(/^M/);
    expect(geometry.width).toBeGreaterThan(geometry.plotWidth);
    expect(geometry.height).toBeGreaterThan(geometry.plotHeight);
    expect(Number.isFinite(geometry.yMax)).toBe(true);
  });
});
