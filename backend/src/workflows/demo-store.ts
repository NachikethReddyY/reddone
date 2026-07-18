import { createHash, randomUUID } from "node:crypto";

import { approvalPayloadHash, type CanonicalApproval } from "@/policy/approval-policy";
import { createDemoPreviewUrl } from "@/server/preview";
import { serializeRunState } from "./run-serialization";
import type {
  Provider,
  RuntimeApproval,
  RuntimeConnection,
  RuntimeEvent,
  RuntimeProject,
  RuntimeRun,
  RuntimeSpec,
  RunKind,
} from "./runtime-types";

const workspaceId = "ws_demo_owner";
const now = () => new Date().toISOString();
const hoursFromNow = (hours: number) => new Date(Date.now() + hours * 3_600_000).toISOString();
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

interface StoreState {
  projects: Map<string, RuntimeProject>;
  runs: Map<string, RuntimeRun>;
  events: Map<string, RuntimeEvent[]>;
  approvals: Map<string, RuntimeApproval>;
  connections: Map<Provider, RuntimeConnection>;
  idempotency: Map<string, unknown>;
}

function latePaySpec(): RuntimeSpec {
  const base = {
    id: "spec_latepay_v3",
    version: 3,
    status: "draft" as const,
    title: "LatePay Copilot",
    summary: "A calm receivables cockpit that tells independent studios who to follow up with, when, and why.",
    audience: "Independent consultants and small creative studios managing 5–50 recurring invoices.",
    jobs: [
      "See which invoices are becoming risky before cash flow is affected.",
      "Send a professional follow-up without rewriting the context every time.",
      "Keep a defensible history of commitments and contact attempts.",
    ],
    features: [
      {
        name: "Risk queue",
        description: "Prioritize open invoices using age, value, broken promises, and client history.",
        acceptance: ["Explains every risk score", "Supports manual reprioritization", "Never sends automatically"],
      },
      {
        name: "Follow-up composer",
        description: "Draft a tone-aware reminder from trusted invoice and communication facts.",
        acceptance: ["Operator approves before send", "Draft cites the facts used", "No invented payment commitments"],
      },
      {
        name: "Promise ledger",
        description: "Record expected payment dates and flag promises that pass without settlement.",
        acceptance: ["Immutable history", "Timezone-aware dates", "One-click dispute note"],
      },
    ],
    nonGoals: ["Payment processing", "Automatic email sending", "Collections agency workflows"],
    updatedAt: now(),
  };
  return { ...base, hash: hash(base) };
}

function latePayConfig(): RuntimeProject["config"] {
  return {
    marketLabel: "Cash-flow operations for independent studios",
    researchContext: "Find repeated, costly receivables work that can become a focused operator-approved web application.",
    researchMode: "fixture",
    sourceLabels: ["Authorized fixture"],
    maxDocumentsPerRun: 100,
    maxCostMicrosPerRun: 7_500_000,
    workspaceTimeZone: "Asia/Singapore",
    hourlyResearchEnabled: false,
    fiveHourPolishEnabled: false,
  };
}

function initialState(): StoreState {
  const spec = latePaySpec();
  const approvalId = "approval_spec_latepay";
  const canonical: CanonicalApproval = {
    id: approvalId,
    kind: "specification_build",
    workspaceId,
    projectId: "project_latepay",
    specHash: spec.hash,
    specVersionId: spec.id,
    specVersion: spec.version,
    specOptimisticVersion: spec.version,
    projectOptimisticVersion: 4,
    providerAccounts: { kimi: "demo-kimi", daytona: "demo-daytona" },
    secretGrants: [],
    costCeilingCents: 750,
    optimisticVersions: { project: 4, spec: 3 },
    expiresAt: hoursFromNow(72),
  };
  const approval: RuntimeApproval = {
    id: approvalId,
    projectId: "project_latepay",
    kind: "specification_build",
    status: "pending",
    title: "Approve specification for build",
    summary: "Build LatePay Copilot v3 in two isolated demo sandboxes with a $7.50 ceiling.",
    payload: { ...canonical },
    payloadHash: approvalPayloadHash(canonical),
    optimisticVersion: 0,
    expiresAt: canonical.expiresAt,
    createdAt: now(),
    resolvedAt: null,
    reason: null,
    upstreamLabel: "Product spec v3",
  };
  const project: RuntimeProject = {
    id: "project_latepay",
    name: "LatePay Copilot",
    marketLabel: "Cash-flow operations for independent studios",
    sourceMode: "fixture",
    sourceLabel: "Authorized fixture · 42 documents",
    config: latePayConfig(),
    status: "needs_approval",
    blocker: "Specification approval required",
    nextAction: "Review and approve Product Spec v3",
    timezone: "Asia/Singapore",
    updatedAt: now(),
    version: 4,
    selectedFindingId: "finding_late_invoice",
    findings: [
      {
        id: "finding_late_invoice",
        title: "Late invoices consume the owner’s attention",
        problem: "Small studios manually reconstruct payment history before every follow-up and delay uncomfortable conversations.",
        score: 91,
        frequency: 94,
        urgency: 88,
        willingnessToPay: 82,
        excerpts: [
          {
            id: "ev_1",
            quote: "I spend Friday morning figuring out who promised what before I can send a single reminder.",
            source: "Authorized fixture · studio operations thread",
            permalink: "https://example.invalid/fixtures/latepay/1",
            score: 96,
          },
          {
            id: "ev_2",
            quote: "The invoice is only two weeks late, but it is half of next month’s payroll.",
            source: "Authorized fixture · freelance finance thread",
            permalink: "https://example.invalid/fixtures/latepay/2",
            score: 91,
          },
        ],
      },
      {
        id: "finding_tone",
        title: "Payment reminders risk the client relationship",
        problem: "Operators want language that is firm enough to work without sounding automated or adversarial.",
        score: 84,
        frequency: 79,
        urgency: 85,
        willingnessToPay: 78,
        excerpts: [
          {
            id: "ev_3",
            quote: "Every reminder feels like choosing between being ignored and sounding hostile.",
            source: "Authorized fixture · consultancy thread",
            permalink: "https://example.invalid/fixtures/latepay/3",
            score: 87,
          },
        ],
      },
    ],
    spec,
    latestRunId: "run_research_complete",
    latestApprovalId: approvalId,
    repository: null,
    deployment: null,
    schedules: { hourlyResearch: false, fiveHourPolish: false, nextResearchAt: null, nextPolishAt: null },
    scheduleVersions: { hourlyResearch: 0, fiveHourPolish: 0 },
  };
  const researchRun: RuntimeRun = {
    id: "run_research_complete",
    projectId: project.id,
    kind: "research",
    status: "succeeded",
    mode: "demo",
    currentStep: "Specification proposed",
    progress: 100,
    startedAt: new Date(Date.now() - 4 * 60_000).toISOString(),
    completedAt: new Date(Date.now() - 2 * 60_000).toISOString(),
    budget: { reservedCents: 250, spentCents: 83, modelTurns: 1, maxModelTurns: 2 },
    artifactHash: null,
    previewUrl: null,
    cancelRequested: false,
    version: 5,
  };
  const connections = new Map<Provider, RuntimeConnection>([
    ["kimi", demoConnection("kimi", "Schema mode · kimi-k2.6")],
    ["daytona", demoConnection("daytona", "Builder + verifier simulation")],
    ["github", demoConnection("github", "Private repository simulation")],
    ["vercel", demoConnection("vercel", "Prebuilt deployment simulation")],
    [
      "reddit",
      {
        provider: "reddit",
        mode: "disabled",
        status: "locked",
        account: null,
        scopes: [],
        maskedSuffix: null,
        lastTestedAt: null,
        message: "Live mode needs a written approval reference. Fixtures and authorized imports remain available.",
        optimisticVersion: 0,
      },
    ],
  ]);
  return {
    projects: new Map([[project.id, project]]),
    runs: new Map([[researchRun.id, researchRun]]),
    events: new Map([
      [
        researchRun.id,
        [
          event(researchRun.id, 1, "info", "research.imported", "Validated 42 fixture documents; remote fetch is disabled."),
          event(researchRun.id, 2, "success", "research.ranked", "Ranked 3 attributable problem candidates."),
          event(researchRun.id, 3, "success", "spec.proposed", "Created Product Spec v3 and requested approval."),
        ],
      ],
    ]),
    approvals: new Map([[approval.id, approval]]),
    connections,
    idempotency: new Map(),
  };
}

function demoConnection(provider: Provider, message: string): RuntimeConnection {
  return {
    provider,
    mode: "demo",
    status: "healthy",
    account: "Demo workspace",
    scopes: ["simulation-only"],
    maskedSuffix: "DEMO",
    lastTestedAt: now(),
    message,
    optimisticVersion: 0,
  };
}

function event(
  runId: string,
  id: number,
  level: RuntimeEvent["level"],
  type: string,
  message: string,
): RuntimeEvent {
  return { id, runId, level, type, message, createdAt: now() };
}

const globalStore = globalThis as typeof globalThis & { __reddoneDemoStore?: StoreState };
export const demoStore = globalStore.__reddoneDemoStore ?? initialState();
if (process.env.NODE_ENV !== "production") globalStore.__reddoneDemoStore = demoStore;

export function resetDemoStore() {
  const fresh = initialState();
  demoStore.projects = fresh.projects;
  demoStore.runs = fresh.runs;
  demoStore.events = fresh.events;
  demoStore.approvals = fresh.approvals;
  demoStore.connections = fresh.connections;
  demoStore.idempotency = fresh.idempotency;
}

export function readIdempotent<T>(key: string): T | undefined {
  return demoStore.idempotency.get(key) as T | undefined;
}

export function writeIdempotent<T>(key: string, value: T) {
  demoStore.idempotency.set(key, value);
  return value;
}

export function listProjects() {
  return [...demoStore.projects.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function normalizeDemoProjectId(projectId: string) {
  return projectId === "latepay-copilot" ? "project_latepay" : projectId;
}

export function getProject(projectId: string) {
  return demoStore.projects.get(normalizeDemoProjectId(projectId)) ?? null;
}

export function createProject(input: { name: string; config: RuntimeProject["config"] }) {
  const id = `project_${randomUUID()}`;
  const sourceMode: RuntimeProject["sourceMode"] = input.config.researchMode === "authorized_import"
    ? "import"
    : input.config.researchMode === "live_reddit"
      ? "reddit"
      : "fixture";
  const project: RuntimeProject = {
    id,
    name: input.name,
    marketLabel: input.config.marketLabel,
    sourceMode,
    sourceLabel:
      sourceMode === "fixture"
        ? "Fixture dataset · awaiting research"
        : sourceMode === "import"
          ? "Authorized import · no documents yet"
          : "Live Reddit · locked pending authorization",
    config: input.config,
    status: "researching",
    blocker: sourceMode === "reddit" ? "Written Reddit authorization required" : null,
    nextAction: sourceMode === "import" ? "Upload an authorized JSON packet" : "Start research",
    timezone: input.config.workspaceTimeZone,
    updatedAt: now(),
    version: 1,
    selectedFindingId: null,
    findings: [],
    spec: null,
    latestRunId: null,
    latestApprovalId: null,
    repository: null,
    deployment: null,
    schedules: { hourlyResearch: false, fiveHourPolish: false, nextResearchAt: null, nextPolishAt: null },
    scheduleVersions: { hourlyResearch: 0, fiveHourPolish: 0 },
  };
  demoStore.projects.set(id, project);
  return project;
}

export type DemoScheduleKind = "hourly_research" | "five_hour_polish";

export function getDemoSchedule(projectId: string, kind: DemoScheduleKind) {
  const project = getProject(projectId);
  if (!project) throw new Error("Project not found.");
  const hourly = kind === "hourly_research";
  const enabled = hourly ? project.schedules.hourlyResearch : project.schedules.fiveHourPolish;
  return {
    projectId: project.id,
    kind,
    enabled,
    intervalMinutes: hourly ? 60 : 300,
    timeZone: project.timezone,
    status: enabled ? "enabled" : "paused",
    nextRunAt: hourly ? project.schedules.nextResearchAt : project.schedules.nextPolishAt,
    lastEnqueuedAt: null,
    lastCompletedAt: null,
    backoffUntil: null,
    consecutiveFailures: 0,
    optimisticVersion: hourly ? project.scheduleVersions.hourlyResearch : project.scheduleVersions.fiveHourPolish,
    mode: "demo" as const,
  };
}

export function updateDemoSchedule(input: {
  projectId: string;
  kind: DemoScheduleKind;
  enabled: boolean;
  expectedVersion: number;
}) {
  const current = getDemoSchedule(input.projectId, input.kind);
  if (current.optimisticVersion !== input.expectedVersion) throw new Error("Schedule version conflict.");
  const project = getProject(input.projectId)!;
  const hourly = input.kind === "hourly_research";
  const nextRunAt = input.enabled
    ? new Date(Date.now() + (hourly ? 60 : 300) * 60_000).toISOString()
    : null;
  if (hourly) {
    project.schedules.hourlyResearch = input.enabled;
    project.schedules.nextResearchAt = nextRunAt;
    project.scheduleVersions.hourlyResearch += 1;
    project.config.hourlyResearchEnabled = input.enabled;
  } else {
    project.schedules.fiveHourPolish = input.enabled;
    project.schedules.nextPolishAt = nextRunAt;
    project.scheduleVersions.fiveHourPolish += 1;
    project.config.fiveHourPolishEnabled = input.enabled;
  }
  project.updatedAt = now();
  return getDemoSchedule(project.id, input.kind);
}

function demoResearchFindings(): RuntimeProject["findings"] {
  return [
    {
      id: `finding_${randomUUID()}`,
      title: "Late invoices consume the owner’s attention",
      problem: "Small studios manually reconstruct payment history before every follow-up and delay uncomfortable conversations.",
      score: 91,
      frequency: 94,
      urgency: 88,
      willingnessToPay: 82,
      excerpts: [
        {
          id: `evidence_${randomUUID()}`,
          quote: "I spend Friday morning figuring out who promised what before I can send a single reminder.",
          source: "Curated fixture · studio operations thread",
          permalink: "https://example.invalid/fixtures/latepay/1",
          score: 96,
        },
      ],
    },
    {
      id: `finding_${randomUUID()}`,
      title: "Payment reminders risk the client relationship",
      problem: "Operators want language that is firm enough to work without sounding automated or adversarial.",
      score: 84,
      frequency: 79,
      urgency: 85,
      willingnessToPay: 78,
      excerpts: [
        {
          id: `evidence_${randomUUID()}`,
          quote: "Every reminder feels like choosing between being ignored and sounding hostile.",
          source: "Curated fixture · consultancy thread",
          permalink: "https://example.invalid/fixtures/latepay/2",
          score: 87,
        },
      ],
    },
  ];
}

export function selectDemoFinding(input: { projectId: string; findingId: string; expectedProjectVersion: number }) {
  const project = getProject(input.projectId);
  if (!project) throw new Error("Project not found.");
  if (project.version !== input.expectedProjectVersion) throw new Error("Project version conflict.");
  if (project.spec) throw new Error("The ProductSpec basis cannot change after a specification exists.");
  if ([...demoStore.runs.values()].some((run) => run.projectId === project.id && run.status === "running")) {
    throw new Error("A workflow is active; wait for it to finish before changing the selected finding.");
  }
  const finding = project.findings.find((item) => item.id === input.findingId);
  if (!finding || finding.excerpts.length === 0) throw new Error("Finding not found or it has no attributable evidence.");
  project.selectedFindingId = finding.id;
  project.blocker = "Generate a ProductSpec from the selected finding";
  project.nextAction = "Generate a ProductSpec";
  project.status = "researching";
  project.updatedAt = now();
  project.version += 1;
  return {
    projectId: project.id,
    findingId: finding.id,
    selectedAt: project.updatedAt,
    optimisticVersion: project.version,
    currentBlocker: project.blocker,
    replayed: false,
  };
}

export function startDemoSpecification(input: { projectId: string; findingId: string; expectedProjectVersion: number }) {
  const project = getProject(input.projectId);
  if (!project) throw new Error("Project not found.");
  if (project.version !== input.expectedProjectVersion) throw new Error("Project version conflict.");
  if (project.selectedFindingId !== input.findingId) throw new Error("The selected finding changed.");
  if (project.spec) throw new Error("A ProductSpec already exists for this project.");
  if (!project.findings.some((finding) => finding.id === input.findingId && finding.excerpts.length > 0)) {
    throw new Error("The selected finding or its attributable evidence is unavailable.");
  }
  if ([...demoStore.runs.values()].some((run) => run.projectId === project.id && run.status === "running")) {
    throw new Error("This project already has an active run.");
  }
  const run = createRunRecord(project, "research");
  appendEvent(run, "info", "spec.finding.loaded", "Loaded the selected persisted finding and its retained evidence.");
  project.spec = latePaySpec();
  appendEvent(run, "success", "spec.proposed", "Created a versioned ProductSpec from the selected finding.");
  newApproval(project, "specification_build");
  run.currentStep = "Specification proposed";
  run.budget.spentCents = 61;
  run.budget.modelTurns = 1;
  run.status = "succeeded";
  run.progress = 100;
  run.completedAt = now();
  run.version += 1;
  project.updatedAt = now();
  return run;
}

function appendEvent(run: RuntimeRun, level: RuntimeEvent["level"], type: string, message: string) {
  const events = demoStore.events.get(run.id) ?? [];
  events.push(event(run.id, (events.at(-1)?.id ?? 0) + 1, level, type, message));
  demoStore.events.set(run.id, events);
}

function createRunRecord(project: RuntimeProject, kind: RunKind): RuntimeRun {
  const run: RuntimeRun = {
    id: `run_${randomUUID()}`,
    projectId: project.id,
    kind,
    status: "running",
    mode: project.sourceMode === "import" ? "import" : "demo",
    currentStep: "Lease acquired",
    progress: 5,
    startedAt: now(),
    completedAt: null,
    budget: {
      reservedCents: kind === "build" ? 750 : kind === "release" ? 100 : 250,
      spentCents: 0,
      modelTurns: 0,
      maxModelTurns: kind === "build" ? 20 : 2,
    },
    artifactHash: null,
    previewUrl: null,
    cancelRequested: false,
    version: 1,
  };
  demoStore.runs.set(run.id, run);
  demoStore.events.set(run.id, []);
  project.latestRunId = run.id;
  project.updatedAt = now();
  project.version += 1;
  appendEvent(run, "info", "run.started", `Started ${kind} run in ${run.mode} mode.`);
  return run;
}

function newApproval(project: RuntimeProject, kind: RuntimeApproval["kind"], artifactHash?: string) {
  const id = `approval_${randomUUID()}`;
  const expiresAt = hoursFromNow(48);
  const isRelease = kind === "first_release" || kind === "polish_release";
  const sourceArtifactHash = artifactHash ? hash({ projectId: project.id, specHash: project.spec?.hash, kind: "demo-source" }) : undefined;
  const repositoryMarker = `reddone-v1-github-${hash({ projectId: project.id, provider: "github" }).slice(0, 24)}`;
  const deploymentMarker = `reddone-v1-vercel-${hash({ projectId: project.id, provider: "vercel" }).slice(0, 24)}`;
  const canonical: CanonicalApproval = {
    id,
    kind,
    workspaceId,
    projectId: project.id,
    specHash: project.spec?.hash ?? hash(project),
    ...(project.spec ? {
      specVersionId: project.spec.id,
      specVersion: project.spec.version,
      specOptimisticVersion: project.spec.version,
    } : {}),
    projectOptimisticVersion: project.version,
    ...(artifactHash && sourceArtifactHash ? {
      artifactId: `artifact_output_${artifactHash.slice(0, 16)}`,
      artifactHash,
      verificationReportId: `verification_${artifactHash.slice(0, 16)}`,
      verificationReportHash: hash({ artifactHash, sourceArtifactHash, gates: "demo-verification-v1" }),
      sourceArtifactId: `artifact_source_${sourceArtifactHash.slice(0, 16)}`,
      sourceArtifactHash,
    } : {}),
    providerAccounts: { kimi: "demo-kimi", daytona: "demo-daytona", github: "demo-github", vercel: "demo-vercel" },
    ...(isRelease
      ? {
          repositoryVisibility: "private" as const,
          deploymentTarget: { teamId: "demo-team", projectId: `demo-${project.id}`, environment: "production" as const },
          repository: {
            owner: "demo-owner",
            name: project.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""),
            visibility: "private" as const,
            installationId: "demo-installation",
            externalRepositoryId: null,
            ownershipMarker: repositoryMarker,
            optimisticVersion: 0,
          },
          deployment: {
            provider: "vercel" as const,
            teamId: "demo-team",
            projectId: `demo-${project.id}`,
            externalProjectId: null,
            ownershipMarker: deploymentMarker,
            environment: "production" as const,
            optimisticVersion: 0,
          },
        }
      : {}),
    secretGrants: [],
    costCeilingCents: kind === "specification_build" ? 750 : 100,
    optimisticVersions: { project: project.version, spec: project.spec?.version ?? 0 },
    expiresAt,
  };
  const approval: RuntimeApproval = {
    id,
    projectId: project.id,
    kind,
    status: "pending",
    title: kind === "specification_build" ? "Approve specification for build" : "Approve first private release",
    summary:
      kind === "specification_build"
        ? `Build ${project.name} from spec v${project.spec?.version ?? 1} with a $7.50 ceiling.`
        : "Create a simulated private repository and promote the verified prebuilt artifact.",
    payload: { ...canonical },
    payloadHash: approvalPayloadHash(canonical),
    optimisticVersion: 0,
    expiresAt,
    createdAt: now(),
    resolvedAt: null,
    reason: null,
    upstreamLabel: kind === "specification_build" ? `Product spec v${project.spec?.version ?? 1}` : "Verified build artifact",
  };
  demoStore.approvals.set(id, approval);
  project.latestApprovalId = id;
  project.blocker = approval.title;
  project.nextAction = `Review ${approval.upstreamLabel}`;
  project.status = "needs_approval";
  return approval;
}

export function startRun(projectId: string, kind: RunKind, expectedProjectVersion?: number) {
  const canonicalProjectId = normalizeDemoProjectId(projectId);
  const project = demoStore.projects.get(canonicalProjectId);
  if (!project) throw new Error("Project not found.");
  if (expectedProjectVersion !== undefined && project.version !== expectedProjectVersion) {
    throw new Error("Project version conflict.");
  }
  if ([...demoStore.runs.values()].some((run) => run.projectId === canonicalProjectId && run.status === "running")) {
    throw new Error("This project already has an active run.");
  }
  if (project.sourceMode === "reddit") throw new Error("Live Reddit research is locked until written authorization is recorded.");
  if (kind === "build" && project.spec?.status !== "approved") throw new Error("Approve the current specification before building.");
  const run = createRunRecord(project, kind);

  // The demo adapter completes deterministically but emits the same bounded state transitions as a durable worker.
  if (kind === "research") {
    appendEvent(run, "info", "research.validated", "Validated the authorized data packet and rejected executable content.");
    appendEvent(run, "success", "research.ranked", "Ranked attributable problems using the fixture evaluator.");
    if (!project.spec) {
      project.findings = demoResearchFindings();
      project.selectedFindingId = null;
      project.blocker = "Choose one ranked finding before generating a ProductSpec";
      project.nextAction = "Choose a ranked finding";
      project.status = "researching";
    }
    run.currentStep = project.spec ? "Incremental findings retained" : "Finding selection required";
    run.budget.spentCents = 22;
    run.budget.modelTurns = 1;
  } else if (kind === "build") {
    project.status = "building";
    appendEvent(run, "info", "sandbox.builder.created", "Created network-blocked builder from pinned snapshot.");
    appendEvent(run, "success", "artifact.manifested", "Exported 18 allowlisted files with content hashes.");
    appendEvent(run, "info", "sandbox.verifier.created", "Reconstructed artifact in a second clean sandbox.");
    appendEvent(run, "success", "verification.passed", "Typecheck, lint, tests, secret scan, and production build passed.");
    run.artifactHash = hash({ projectId: canonicalProjectId, spec: project.spec?.hash, seed: "demo-artifact-v1" });
    run.previewUrl = createDemoPreviewUrl({ artifactId: run.id, artifactHash: run.artifactHash });
    run.budget.spentCents = 416;
    run.budget.modelTurns = 8;
    newApproval(project, "first_release", run.artifactHash);
    run.currentStep = "Verified · release approval requested";
  } else if (kind === "polish") {
    appendEvent(run, "success", "polish.proposed", "Created a diff proposal; production remains unchanged.");
    newApproval(project, "polish_release", run.artifactHash ?? undefined);
    run.currentStep = "Polish proposal ready";
    run.budget.spentCents = 61;
    run.budget.modelTurns = 1;
  } else if (kind === "release") {
    appendEvent(run, "success", "github.repository.created", "Created simulated private repository after approval consumption.");
    appendEvent(run, "success", "vercel.prebuilt.deployed", "Uploaded verified prebuilt output; no build-time secret exposure.");
    appendEvent(run, "success", "deployment.promoted", "Health check passed and deployment was promoted.");
    const verifiedBuild = [...demoStore.runs.values()]
      .filter((candidate) => candidate.projectId === project.id && candidate.kind === "build" && candidate.status === "succeeded" && candidate.artifactHash)
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt))[0];
    if (!verifiedBuild?.artifactHash) throw new Error("A verified build artifact is required before release.");
    const releasedAt = now();
    project.repository = {
      fullName: `demo-owner/${project.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
      url: "https://github.com/example/reddone-demo-private",
      visibility: "private",
      defaultBranch: "main",
      installationId: "demo-installation",
      lastCommitSha: hash({ artifactHash: verifiedBuild.artifactHash, provider: "github" }).slice(0, 40),
    };
    project.deployment = {
      id: `demo-deployment-${verifiedBuild.artifactHash.slice(0, 12)}`,
      externalProjectId: `demo-${project.id}`,
      externalDeploymentId: `demo-dpl-${verifiedBuild.artifactHash.slice(0, 12)}`,
      teamId: "Demo workspace",
      artifactHash: verifiedBuild.artifactHash,
      url: "https://latepay-demo.example.invalid",
      healthCheckUrl: "https://latepay-demo.example.invalid/api/health",
      health: "healthy",
      lastKnownGoodUrl: "https://latepay-demo.example.invalid",
      createdAt: releasedAt,
      promotedAt: releasedAt,
    };
    project.status = "live";
    project.blocker = null;
    project.nextAction = "Review evidence before enabling a polish schedule";
    run.currentStep = "Promoted after health check";
    run.budget.spentCents = 0;
  }

  run.status = "succeeded";
  run.progress = 100;
  run.completedAt = now();
  run.version += 1;
  project.updatedAt = now();
  return run;
}

export function getRun(runId: string) {
  return demoStore.runs.get(runId) ?? null;
}

export function serializeDemoRunState(run: RuntimeRun) {
  return serializeRunState({
    id: run.id,
    projectId: run.projectId,
    kind: run.kind,
    status: run.status === "awaiting_approval" ? "waiting_for_approval" : run.status,
    stateVersion: run.version,
    attempt: 1,
    currentStepKey: run.status === "running" || run.status === "queued" ? run.currentStep : null,
    steps: [],
    budgetCeilingMicros: BigInt(run.budget.reservedCents * 10_000),
    reservedMicros: BigInt(run.budget.reservedCents * 10_000),
    actualCostMicros: BigInt(run.budget.spentCents * 10_000),
    cancelRequestedAt: run.cancelRequested && run.completedAt ? new Date(run.completedAt) : null,
    startedAt: new Date(run.startedAt),
    finishedAt: run.completedAt ? new Date(run.completedAt) : null,
    createdAt: new Date(run.startedAt),
    updatedAt: new Date(run.completedAt ?? run.startedAt),
  });
}

export function serializeDemoRun(run: RuntimeRun) {
  return {
    ...serializeDemoRunState(run),
    mode: run.mode,
    currentStep: run.currentStep,
    progress: run.progress,
    artifactHash: run.artifactHash,
    previewUrl: run.previewUrl,
    budget: run.budget,
  };
}

export function listEvents(runId: string, after = 0, limit = 100) {
  const items = (demoStore.events.get(runId) ?? []).filter((item) => item.id > after).slice(0, limit);
  return { items, nextCursor: items.at(-1)?.id ?? after, hasMore: (demoStore.events.get(runId) ?? []).some((item) => item.id > (items.at(-1)?.id ?? after)) };
}

export function resolveApproval(input: {
  approvalId: string;
  decision: "approve" | "reject";
  reason?: string;
  payloadHash?: string;
  expectedVersion?: number;
}) {
  const approval = demoStore.approvals.get(input.approvalId);
  if (!approval) throw new Error("Approval not found.");
  if (input.payloadHash !== undefined && input.payloadHash !== approval.payloadHash) {
    throw new Error("Approval payload integrity check failed.");
  }
  if (input.expectedVersion !== undefined && input.expectedVersion !== approval.optimisticVersion) {
    throw new Error("Approval version does not match If-Match.");
  }
  if (approval.status !== "pending") throw new Error("Approval has already been resolved.");
  if (new Date(approval.expiresAt) <= new Date()) {
    approval.status = "expired";
    throw new Error("Approval has expired.");
  }
  const project = demoStore.projects.get(approval.projectId);
  if (!project) throw new Error("Project not found.");
  approval.status = input.decision === "approve" ? "approved" : "rejected";
  approval.optimisticVersion += 1;
  approval.resolvedAt = now();
  approval.reason = input.reason?.trim() || null;
  if (input.decision === "reject") {
    project.blocker = "Approval rejected; upstream revision required";
    project.nextAction = `Revise ${approval.upstreamLabel}`;
    return { approval, run: null };
  }
  if (approval.kind === "specification_build") {
    if (project.spec) project.spec.status = "approved";
    approval.status = "consumed";
    project.status = "release_ready";
    project.blocker = null;
    project.nextAction = "Start an isolated build";
    return { approval, run: null };
  }
  if (approval.kind === "first_release" || approval.kind === "polish_release") {
    approval.status = "consumed";
    return { approval, run: startRun(project.id, "release") };
  }
  return { approval, run: null };
}

export function listApprovals(projectId?: string) {
  return [...demoStore.approvals.values()]
    .filter((approval) => !projectId || approval.projectId === normalizeDemoProjectId(projectId))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function updateSpec(input: { specId: string; expectedVersion: number; patch: Partial<Pick<RuntimeSpec, "title" | "summary" | "audience" | "jobs" | "features" | "nonGoals">> }) {
  const project = [...demoStore.projects.values()].find((item) => item.spec?.id === input.specId);
  if (!project?.spec) throw new Error("Specification not found.");
  if (project.spec.version !== input.expectedVersion) throw new Error("Specification version conflict.");
  const updated = { ...project.spec, ...input.patch, version: project.spec.version + 1, status: "draft" as const, updatedAt: now() };
  updated.hash = hash({ ...updated, hash: undefined });
  project.spec = updated;
  project.version += 1;
  project.updatedAt = now();
  project.blocker = "Updated specification needs approval";
  const approval = newApproval(project, "specification_build");
  return { spec: updated, approval };
}

export function cancelRun(runId: string, expectedVersion?: number) {
  const run = demoStore.runs.get(runId);
  if (!run) throw new Error("Run not found.");
  if (expectedVersion !== undefined && run.version !== expectedVersion) throw new Error("Run version conflict.");
  if (run.status !== "running" && run.status !== "queued") throw new Error("Only an active run can be canceled.");
  run.cancelRequested = true;
  run.status = "canceled";
  run.completedAt = now();
  run.version += 1;
  appendEvent(run, "warning", "run.canceled", "Cancellation acknowledged; sandbox cleanup was requested.");
  return run;
}

export function listConnections() {
  return [...demoStore.connections.values()];
}

export function getConnection(provider: Provider) {
  return demoStore.connections.get(provider) ?? null;
}

export function updateConnectionMetadata(provider: Provider, patch: Partial<RuntimeConnection>, expectedVersion?: number) {
  const current = demoStore.connections.get(provider) ?? {
    provider,
    mode: "live" as const,
    status: "untested" as const,
    account: null,
    scopes: [],
    maskedSuffix: null,
    lastTestedAt: null,
    message: "Credential stored; test the connection before use.",
    optimisticVersion: 0,
  };
  if (expectedVersion !== undefined && current.optimisticVersion !== expectedVersion) {
    throw new Error("Connection version conflict.");
  }
  const updated = { ...current, ...patch, provider, optimisticVersion: current.optimisticVersion + 1 };
  demoStore.connections.set(provider, updated);
  return updated;
}
