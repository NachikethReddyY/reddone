import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findProject: vi.fn(),
  findRuns: vi.fn(),
}));

vi.mock("@/server/db", () => ({
  getDb: () => ({
    project: { findUnique: mocks.findProject },
    workflowRun: { findMany: mocks.findRuns },
  }),
}));

import { estimateProjectRun } from "@/server/usage-estimator";

describe("run-estimator usage query", () => {
  beforeEach(() => {
    mocks.findProject.mockReset();
    mocks.findRuns.mockReset();
    mocks.findProject.mockResolvedValue({
      id: "project-1",
      name: "Estimator test",
      marketLabel: "Release operations",
      researchContext: "Estimate provider usage without mixing ledgers.",
      config: {
        marketLabel: "Release operations",
        researchContext: "Estimate provider usage without mixing ledgers.",
        researchMode: "fixture",
        sourceLabels: [],
        maxDocumentsPerRun: 100,
        maxCostMicrosPerRun: 5_000_000,
        workspaceTimeZone: "Asia/Singapore",
        hourlyResearchEnabled: false,
        fiveHourPolishEnabled: false,
      },
      currentSpecVersionId: null,
    });
    mocks.findRuns.mockResolvedValue(Array.from({ length: 5 }, (_, index) => ({
      usageEntries: [{ inputUnits: BigInt(index + 1), outputUnits: 1n }],
    })));
  });

  it("qualifies and selects historical samples by Kimi provider and model", async () => {
    await estimateProjectRun({
      workspaceId: "workspace-1",
      projectId: "project-1",
      kind: "build",
      model: "shared-model-name",
    });

    expect(mocks.findRuns).toHaveBeenCalledTimes(1);
    expect(mocks.findRuns).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        workspaceId: "workspace-1",
        projectId: "project-1",
        usageEntries: { some: { provider: "KIMI", model: "shared-model-name" } },
      }),
      select: {
        usageEntries: {
          where: { provider: "KIMI", model: "shared-model-name" },
          select: { inputUnits: true, outputUnits: true },
        },
      },
    }));
  });
});
