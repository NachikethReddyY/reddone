import { describe, expect, it } from "vitest";

import { GenerateFindingSpecInputSchema } from "@/contracts";
import {
  createProject,
  getProject,
  listApprovals,
  resetDemoStore,
  selectDemoFinding,
  startDemoSpecification,
  startRun,
} from "@/workflows/demo-store";
import { rankResearchCandidates } from "@/workflows/research-candidates";

const documents = [
  { id: "evidence-a", title: "A", body: "Repeated manual follow-up consumes Friday morning." },
  { id: "evidence-b", title: "B", body: "A delayed invoice puts payroll at risk." },
];

describe("ranked finding persistence inputs", () => {
  it("merges duplicate problem candidates and retains every authorized citation", () => {
    const ranked = rankResearchCandidates([
      {
        title: "Late invoices consume attention",
        problem: "Owners reconstruct payment promises before every reminder.",
        proposedSolution: "Create a review queue that assembles payment promises before each reminder is sent.",
        audience: "Independent studios",
        frequency: 80,
        urgency: 90,
        willingnessToPay: 70,
        evidenceIds: ["evidence-a"],
      },
      {
        title: "  Late invoices consume attention  ",
        problem: "Owners reconstruct payment promises before every reminder.",
        proposedSolution: "Create a review queue that assembles payment promises before each reminder is sent.",
        audience: "Independent studios",
        frequency: 85,
        urgency: 88,
        willingnessToPay: 75,
        evidenceIds: ["evidence-a", "evidence-b", "evidence-b"],
      },
      {
        title: "Reminder tone is hard",
        problem: "Owners delay outreach because a firm reminder can damage trust.",
        proposedSolution: "Draft evidence-aware reminder variants for the owner to review and send manually.",
        audience: "Independent studios",
        frequency: 60,
        urgency: 65,
        willingnessToPay: 55,
        evidenceIds: ["evidence-b"],
      },
    ], documents);

    expect(ranked).toHaveLength(2);
    expect(ranked[0]).toMatchObject({
      rank: 1,
      frequency: 85,
      urgency: 90,
      willingnessToPay: 75,
      proposedSolution: "Create a review queue that assembles payment promises before each reminder is sent.",
    });
    expect(ranked[0]?.documents.map((item) => item.id)).toEqual(["evidence-a", "evidence-b"]);
    expect(ranked[1]?.rank).toBe(2);
  });

  it("fails closed for unknown or ambiguous evidence IDs", () => {
    expect(() => rankResearchCandidates([{
      title: "Unknown citation",
      problem: "This problem cites content outside the packet.",
      proposedSolution: "Show only problem claims backed by an authorized source in the research packet.",
      audience: "Owners",
      frequency: 50,
      urgency: 50,
      willingnessToPay: 50,
      evidenceIds: ["not-authorized"],
    }], documents)).toThrow(/outside the authorized packet/i);

    expect(() => rankResearchCandidates([{
      title: "Ambiguous citation",
      problem: "This problem cites a duplicate identifier.",
      proposedSolution: "Stop the run and ask the owner to resolve duplicate source identifiers.",
      audience: "Owners",
      frequency: 50,
      urgency: 50,
      willingnessToPay: 50,
      evidenceIds: ["evidence-a"],
    }], [documents[0]!, { ...documents[0]!, body: "Different content under the same identifier." }])).toThrow(/ambiguous evidence ID/i);
  });
});

describe("selection-gated demo flow", () => {
  it("stops research at selection, then creates the spec in a separate run", () => {
    resetDemoStore();
    const project = createProject({
      name: "Invoice Signal",
      config: {
        marketLabel: "Studio finance",
        researchContext: "Find repeated receivables work.",
        researchMode: "fixture",
        sourceLabels: ["Curated fixture"],
        maxDocumentsPerRun: 50,
        maxCostMicrosPerRun: 5_000_000,
        workspaceTimeZone: "Asia/Singapore",
        hourlyResearchEnabled: false,
        fiveHourPolishEnabled: false,
      },
    });
    const research = startRun(project.id, "research", project.version);
    const researched = getProject(project.id)!;

    expect(research.status).toBe("succeeded");
    expect(researched.findings).toHaveLength(2);
    expect(researched.selectedFindingId).toBeNull();
    expect(researched.spec).toBeNull();
    expect(researched.blocker).toMatch(/choose one ranked finding/i);

    const findingId = researched.findings[1]!.id;
    const selection = selectDemoFinding({ projectId: project.id, findingId, expectedProjectVersion: researched.version });
    expect(selection.findingId).toBe(findingId);
    expect(getProject(project.id)?.selectedFindingId).toBe(findingId);

    const specRun = startDemoSpecification({
      projectId: project.id,
      findingId,
      expectedProjectVersion: selection.optimisticVersion,
    });
    expect(specRun.status).toBe("succeeded");
    expect(getProject(project.id)?.spec).not.toBeNull();
    expect(listApprovals(project.id).some((approval) => approval.kind === "specification_build" && approval.status === "pending")).toBe(true);
  });

  it("requires a positive bounded specification budget", () => {
    expect(GenerateFindingSpecInputSchema.safeParse({ budgetCeilingMicros: 0 }).success).toBe(false);
    expect(GenerateFindingSpecInputSchema.parse({ budgetCeilingMicros: 2_500_000 })).toEqual({ budgetCeilingMicros: 2_500_000 });
  });
});
