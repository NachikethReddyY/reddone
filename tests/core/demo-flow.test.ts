import { describe, expect, it } from "vitest";

import {
  getDemoSchedule,
  getProject,
  listApprovals,
  resetDemoStore,
  resolveApproval,
  startRun,
  updateDemoSchedule,
} from "@/workflows/demo-store";

describe("demo vertical slice", () => {
  it("moves an approved spec through dual-sandbox build and release approval", () => {
    resetDemoStore();
    const specApproval = listApprovals("project_latepay").find((approval) => approval.kind === "specification_build");
    expect(specApproval?.status).toBe("pending");

    resolveApproval({ approvalId: specApproval!.id, decision: "approve" });
    expect(getProject("latepay-copilot")?.spec?.status).toBe("approved");
    expect(getProject("latepay-copilot")?.config.maxCostMicrosPerRun).toBe(7_500_000);

    const build = startRun("latepay-copilot", "build");
    expect(build.status).toBe("succeeded");
    expect(build.artifactHash).toHaveLength(64);

    const releaseApproval = listApprovals("latepay-copilot").find((approval) => approval.kind === "first_release");
    expect(releaseApproval?.status).toBe("pending");
    const released = resolveApproval({ approvalId: releaseApproval!.id, decision: "approve" });
    expect(released.run?.kind).toBe("release");
    expect(getProject("latepay-copilot")?.status).toBe("live");
    expect(getProject("latepay-copilot")?.repository?.visibility).toBe("private");
    expect(getProject("latepay-copilot")?.deployment?.artifactHash).toBe(build.artifactHash);
  });

  it("persists a versioned schedule and computes its next UTC run", () => {
    resetDemoStore();
    expect(getDemoSchedule("project_latepay", "hourly_research")).toMatchObject({
      enabled: false,
      nextRunAt: null,
      optimisticVersion: 0,
    });

    const enabled = updateDemoSchedule({
      projectId: "project_latepay",
      kind: "hourly_research",
      enabled: true,
      expectedVersion: 0,
    });
    expect(enabled.enabled).toBe(true);
    expect(enabled.nextRunAt).toBeTruthy();
    expect(enabled.optimisticVersion).toBe(1);
    expect(() => updateDemoSchedule({
      projectId: "project_latepay",
      kind: "hourly_research",
      enabled: false,
      expectedVersion: 0,
    })).toThrow(/version conflict/i);
  });
});
