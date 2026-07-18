import { afterEach, describe, expect, it, vi } from "vitest";

import { kimiUsageCostMicros } from "@/server/usage";
import { assertWorkspaceBudgetAvailable } from "@/server/budget";

afterEach(() => vi.unstubAllEnvs());

describe("provider and workspace budgets", () => {
  it("prices metered Kimi units in integer microdollars with ceiling rounding", () => {
    vi.stubEnv("KIMI_INPUT_COST_MICROS_PER_MILLION", "1000000");
    vi.stubEnv("KIMI_OUTPUT_COST_MICROS_PER_MILLION", "2000000");
    expect(kimiUsageCostMicros({ inputUnits: 3, outputUnits: 4 })).toBe(11n);

    vi.stubEnv("KIMI_INPUT_COST_MICROS_PER_MILLION", "1");
    vi.stubEnv("KIMI_OUTPUT_COST_MICROS_PER_MILLION", "0");
    expect(kimiUsageCostMicros({ inputUnits: 1, outputUnits: 0 })).toBe(1n);
  });

  it("counts current-month spend plus only the unused portion of active reservations", async () => {
    const tx = {
      budgetReservation: {
        findMany: vi.fn().mockResolvedValue([
          { reservedMicros: 500n, actualMicros: 100n, status: "RESERVED", createdAt: new Date("2026-07-02T00:00:00.000Z") },
          { reservedMicros: 200n, actualMicros: 200n, status: "COMMITTED", createdAt: new Date("2026-07-03T00:00:00.000Z") },
          { reservedMicros: 50n, actualMicros: 75n, status: "EXCEEDED", createdAt: new Date("2026-06-30T00:00:00.000Z") },
        ]),
      },
    };
    await expect(assertWorkspaceBudgetAvailable(tx as never, {
      workspaceId: "workspace-1",
      monthlyBudgetMicros: 1_000n,
      requestedMicros: 300n,
      now: new Date("2026-07-11T00:00:00.000Z"),
    })).resolves.toBeUndefined();
    await expect(assertWorkspaceBudgetAvailable(tx as never, {
      workspaceId: "workspace-1",
      monthlyBudgetMicros: 1_000n,
      requestedMicros: 301n,
      now: new Date("2026-07-11T00:00:00.000Z"),
    })).rejects.toThrow(/monthly budget/i);
  });
});
