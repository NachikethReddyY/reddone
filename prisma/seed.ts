import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required to seed the database");

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

const IDS = {
  workspace: "00000000-0000-4000-8000-000000000001",
  project: "00000000-0000-4000-8000-000000000010",
  source: "00000000-0000-4000-8000-000000000020",
  finding: "00000000-0000-4000-8000-000000000030",
  evidence: "00000000-0000-4000-8000-000000000040",
  spec: "00000000-0000-4000-8000-000000000050",
} as const;

async function seed(): Promise<void> {
  await prisma.workspace.upsert({
    where: { id: IDS.workspace },
    update: { name: "ReDDone Demo Workspace", timeZone: "Asia/Singapore" },
    create: {
      id: IDS.workspace,
      name: "ReDDone Demo Workspace",
      timeZone: "Asia/Singapore",
      maxConcurrentSandboxes: 2,
      monthlyBudgetMicros: 50_000_000n,
    },
  });

  await prisma.project.upsert({
    where: { workspaceId_slug: { workspaceId: IDS.workspace, slug: "latepay-copilot" } },
    update: {
      name: "LatePay Copilot",
      status: "AWAITING_SPEC_APPROVAL",
      selectedFindingId: null,
      currentSpecVersionId: null,
    },
    create: {
      id: IDS.project,
      workspaceId: IDS.workspace,
      name: "LatePay Copilot",
      slug: "latepay-copilot",
      marketLabel: "Freelancer cash-flow operations",
      researchContext: "Identify repetitive, expensive late-payment workflows that can be solved by a focused web app.",
      researchMode: "FIXTURE",
      status: "AWAITING_SPEC_APPROVAL",
      config: {
        sourceLabels: ["fixture/freelance"],
        maxDocumentsPerRun: 100,
        maxCostMicrosPerRun: 5_000_000,
        hourlyResearchEnabled: false,
        fiveHourPolishEnabled: false,
      },
    },
  });

  await prisma.researchSource.upsert({
    where: { id: IDS.source },
    update: { label: "Late-payment fixture" },
    create: {
      id: IDS.source,
      workspaceId: IDS.workspace,
      projectId: IDS.project,
      mode: "FIXTURE",
      label: "Late-payment fixture",
      externalRef: "fixture://late-payments/v1",
      metadata: { license: "synthetic" },
    },
  });

  await prisma.finding.upsert({
    where: { id: IDS.finding },
    update: { totalScore: 88.5 },
    create: {
      id: IDS.finding,
      workspaceId: IDS.workspace,
      projectId: IDS.project,
      title: "Freelancers repeatedly chase overdue invoices",
      problemSummary: "Independent workers lose time and predictability while manually tracking and escalating overdue invoices.",
      audience: "Freelancers and small independent studios",
      frequencyScore: 92,
      severityScore: 86,
      willingnessToPayScore: 82,
      feasibilityScore: 94,
      totalScore: 88.5,
      scoreExplanation: "The workflow is frequent, measurable, narrow enough for an MVP, and directly connected to cash flow.",
      selectedAt: new Date(),
      model: "fixture",
      promptVersion: "fixture-v1",
      schemaVersion: "1",
    },
  });

  await prisma.evidenceExcerpt.upsert({
    where: { id: IDS.evidence },
    update: { retainedBySpecVersionId: null },
    create: {
      id: IDS.evidence,
      workspaceId: IDS.workspace,
      projectId: IDS.project,
      findingId: IDS.finding,
      sourceExternalId: "fixture-latepay-001",
      excerpt: "I spend part of every Friday checking invoices and writing the same increasingly awkward reminder messages.",
      permalink: "https://example.invalid/authorized-fixture/latepay-001",
      attribution: "Synthetic authorized fixture",
      contentHash: "d799b8d8f6e0591d98e1a3369b13d85f2c6ef0c3aa745f1c2561731b6ad7b299",
      retainedBySpecVersionId: null,
    },
  });

  await prisma.productSpecVersion.upsert({
    where: { id: IDS.spec },
    update: { status: "PENDING_APPROVAL" },
    create: {
      id: IDS.spec,
      workspaceId: IDS.workspace,
      projectId: IDS.project,
      basedOnFindingId: IDS.finding,
      version: 1,
      status: "PENDING_APPROVAL",
      contentHash: "9c6cce87d5dd7518e2da76a93662fc6b5df4b3dc2300f2b07e6531aeb459408f",
      schemaVersion: "1",
      model: "fixture",
      promptVersion: "fixture-v1",
      content: {
        productName: "LatePay Copilot",
        oneLinePitch: "Track overdue invoices and prepare calm, evidence-based follow-ups.",
        problem: "Freelancers manually track invoices and recreate reminder messages, losing time and cash-flow visibility.",
        targetAudience: "Freelancers and small studios that invoice clients directly.",
        proposedSolution: "A focused dashboard that records invoice state and drafts an escalating reminder sequence for owner review.",
        inScope: ["Invoice status dashboard", "Reminder sequence drafts", "Manual send confirmation"],
        outOfScope: ["Payment processing", "Automatic email sending", "Accounting replacement"],
        userStories: [
          { actor: "freelancer", need: "see every overdue invoice", outcome: "prioritize follow-up work" },
        ],
        acceptanceCriteria: ["An owner can add and update an invoice", "The app proposes but never sends reminders automatically"],
        constraints: ["No generated authentication or external database"],
        risks: ["Reminder tone must remain professional"],
        evidenceIds: [IDS.evidence],
      },
    },
  });

  await prisma.evidenceExcerpt.update({
    where: { id: IDS.evidence },
    data: { retainedBySpecVersionId: IDS.spec },
  });

  await prisma.project.update({
    where: { id: IDS.project },
    data: {
      selectedFindingId: IDS.finding,
      currentSpecVersionId: IDS.spec,
    },
  });
}

seed()
  .then(() => prisma.$disconnect())
  .catch(async (error: unknown) => {
    console.error(error instanceof Error ? error.message : "Database seed failed");
    await prisma.$disconnect();
    process.exitCode = 1;
  });
