import { describe, expect, it } from "vitest";

import { normalizeProjectView, projectLifecycleFor } from "@/features/project-detail/project-view-data";

describe("project detail view normalization", () => {
  it("normalizes the demo runtime project without inventing external resources", () => {
    const project = normalizeProjectView({
      id: "project_demo",
      name: "LatePay Copilot",
      marketLabel: "Studio cash flow",
      sourceMode: "fixture",
      sourceLabel: "Authorized fixture · 42 documents",
      status: "needs_approval",
      blocker: "Specification approval required",
      latestApprovalId: "approval_1",
      findings: [{
        id: "finding_1",
        title: "Late invoices consume attention",
        problem: "Operators reconstruct every payment promise by hand.",
        score: 91,
        frequency: 94,
        urgency: 88,
        willingnessToPay: 82,
        excerpts: [{ id: "ev_1", quote: "Friday disappears into follow-up.", source: "Fixture thread", permalink: "https://example.invalid/1", score: 96 }],
      }],
      spec: { id: "spec_1", version: 3, status: "draft", title: "LatePay Copilot", summary: "A calm receivables cockpit.", audience: "Independent studios", jobs: ["Prioritize payment risk"], hash: "abc" },
      repository: null,
      deployment: null,
      schedules: { hourlyResearch: false, fiveHourPolish: false },
    }, "project_demo");

    expect(project.sourceMode).toBe("fixture");
    expect(project.pendingApproval?.id).toBe("approval_1");
    expect(project.selectedFinding?.id).toBe("finding_1");
    expect(project.findings[0]?.scores.frequency).toBe(9.4);
    expect(project.findings[0]?.evidence[0]?.quote).toBe("Friday disappears into follow-up.");
    expect(project.spec?.workflow).toEqual(["Prioritize payment risk"]);
    expect(project.repository).toBeNull();
    expect(project.deployment).toBeNull();
  });

  it("normalizes the Prisma project graph and keeps authorization explicit", () => {
    const project = normalizeProjectView({
      id: "8f35fc9e-6df5-4305-a9e2-f135ad01deae",
      name: "ScopeGuard",
      marketLabel: "Agency operations",
      researchMode: "LIVE_REDDIT",
      status: "AWAITING_RELEASE_APPROVAL",
      selectedFindingId: "finding_2",
      currentSpecVersionId: "spec_2",
      sources: [{ label: "Approved community set", authorizedAt: "2026-07-01T00:00:00.000Z" }],
      findings: [{
        id: "finding_2",
        title: "Scope changes hide in long threads",
        problemSummary: "Teams miss billable changes when decisions are scattered across messages.",
        solutionConcept: "Create a review queue that turns scattered scope changes into owner-confirmed billable decisions.",
        frequencyScore: "80.00",
        severityScore: "90.00",
        willingnessToPayScore: "70.00",
        feasibilityScore: "85.00",
        totalScore: "84.00",
        evidence: [{ id: "evidence_2", excerpt: "The request looked small until delivery day.", sourceExternalId: "thread-42", attribution: "Authorized export", permalink: "https://example.com/thread/42" }],
      }],
      specVersions: [{
        id: "spec_2",
        version: 2,
        status: "APPROVED",
        contentHash: "hash_2",
        updatedAt: "2026-07-02T00:00:00.000Z",
        content: {
          productName: "ScopeGuard",
          oneLinePitch: "Turn scope changes into a review queue.",
          targetAudience: "Small agencies",
          userStories: [{ actor: "Owner", need: "review changed requirements", outcome: "billable work stays visible" }],
        },
      }],
      runs: [{ id: "run_2", kind: "BUILD", status: "SUCCEEDED", actualCostMicros: "4200000", steps: [{ id: "step_2", label: "Verify artifact", status: "SUCCEEDED", finishedAt: "2026-07-03T00:00:00.000Z" }] }],
      approvals: [{ id: "approval_2", kind: "FIRST_RELEASE", status: "PENDING", expiresAt: "2026-07-20T00:00:00.000Z", payload: { costCeilingMicros: "5000000" } }],
      repository: { owner: "private-owner", name: "scopeguard", visibility: "private" },
      deployments: [],
      schedules: [{ status: "ENABLED" }, { status: "PAUSED" }],
    }, "fallback");

    expect(project.sourceMode).toBe("live");
    expect(project.liveAuthorized).toBe(true);
    expect(project.selectedFinding?.id).toBe("finding_2");
    expect(project.selectedFinding?.solution).toMatch(/owner-confirmed billable decisions/);
    expect(project.optimisticVersion).toBe(0);
    expect(project.spec?.title).toBe("ScopeGuard");
    expect(project.spec?.workflow[0]).toContain("billable work stays visible");
    expect(project.runs[0]?.actualCostMicros).toBe(4_200_000);
    expect(project.pendingApproval?.costCeilingMicros).toBe(5_000_000);
    expect(project.repository?.fullName).toBe("private-owner/scopeguard");
    expect(project.schedulesEnabled).toBe(1);
  });

  it("exposes one canonical seven-stage lifecycle with a plain-language build blocker", () => {
    const project = normalizeProjectView({
      id: "project-build-failed",
      name: "ScopeGuard",
      marketLabel: "Agency operations",
      status: "FAILED",
      selectedFindingId: "finding-1",
      findings: [{ id: "finding-1", title: "Scope changes hide", selected: true, excerpts: [] }],
      currentSpecVersionId: "spec-1",
      specVersions: [{ id: "spec-1", version: 1, status: "APPROVED", contentHash: "abcdef1234567890", content: { productName: "ScopeGuard" } }],
      runs: [{ id: "run-1", kind: "BUILD", status: "FAILED", currentStepKey: "build.verifier", steps: [] }],
    }, "project-build-failed");

    const lifecycle = projectLifecycleFor(project);
    expect(lifecycle.stages.map((stage) => stage.label)).toEqual([
      "Define project",
      "Research",
      "Select evidence",
      "Generate or edit ProductSpec",
      "Approve specification",
      "Build and verify",
      "Approve and release",
    ]);
    expect(lifecycle.current.id).toBe("build");
    expect(lifecycle.stages.filter((stage) => stage.state === "current")).toHaveLength(1);
    expect(lifecycle.blocker).toMatch(/stopped during verifier/i);
    expect(lifecycle.primaryAction).toMatchObject({ label: "Review and retry build", href: "/projects/project-build-failed/builds" });
  });

  it("makes every completed stage navigable and expands release after success", () => {
    const project = normalizeProjectView({
      id: "project-release",
      name: "ScopeGuard",
      marketLabel: "Agency operations",
      status: "AWAITING_RELEASE_APPROVAL",
      selectedFindingId: "finding-1",
      findings: [{ id: "finding-1", title: "Scope changes hide", selected: true, excerpts: [] }],
      currentSpecVersionId: "spec-1",
      specVersions: [{ id: "spec-1", version: 1, status: "APPROVED", contentHash: "abcdef1234567890", content: { productName: "ScopeGuard" } }],
      runs: [{ id: "run-1", kind: "BUILD", status: "SUCCEEDED", steps: [] }],
      approvals: [{ id: "approval-1", kind: "FIRST_RELEASE", status: "PENDING" }],
    }, "project-release");

    const lifecycle = projectLifecycleFor(project);
    expect(lifecycle.current.id).toBe("release");
    expect(lifecycle.stages.slice(0, 6).every((stage) => stage.state === "complete" && stage.href.length > 0)).toBe(true);
    expect(lifecycle.blocker).toMatch(/verified build needs owner approval/i);
  });
});
