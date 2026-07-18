export type ViewSourceMode = "fixture" | "import" | "live";

export type ProjectLifecycleStageId = "define" | "research" | "select" | "specify" | "approve-spec" | "build" | "release";
export type ProjectLifecycleStageState = "complete" | "current" | "upcoming";

export interface ProjectLifecycleStage {
  id: ProjectLifecycleStageId;
  label: string;
  summary: string;
  href: string;
  state: ProjectLifecycleStageState;
}

export interface ProjectLifecycle {
  stages: ProjectLifecycleStage[];
  current: ProjectLifecycleStage;
  blocker: string;
  primaryAction: { label: string; href: string; kind: "research" | "generate-spec" | "navigate" };
}

export type FindingScoreKey = "frequency" | "urgency" | "willingness" | "buildability";

export interface ProjectFindingView {
  id: string;
  rank: number;
  title: string;
  summary: string;
  solution: string | null;
  score: number;
  scores: Record<FindingScoreKey, number>;
  selected: boolean;
  evidence: Array<{
    id: string;
    quote: string;
    source: string;
    sourceId: string;
    attribution: string;
    permalink: string | null;
  }>;
}

export interface ProjectSpecView {
  id: string;
  version: number;
  status: string;
  title: string;
  oneLiner: string;
  targetUser: string;
  workflow: string[];
  hash: string;
  updatedAt: string | null;
}

export interface ProjectRunView {
  id: string;
  kind: string;
  status: string;
  currentStep: string | null;
  actualCostMicros: number;
  updatedAt: string | null;
  steps: Array<{ id: string; label: string; status: string; updatedAt: string | null }>;
}

export interface ProjectApprovalView {
  id: string;
  kind: string;
  status: string;
  expiresAt: string | null;
  costCeilingMicros: number | null;
}

export interface ProjectViewModel {
  id: string;
  name: string;
  marketLabel: string;
  status: string;
  blocker: string | null;
  nextAction: string;
  optimisticVersion: number;
  maxCostMicrosPerRun: number;
  updatedAt: string | null;
  sourceMode: ViewSourceMode;
  sourceLabel: string;
  liveAuthorized: boolean;
  findings: ProjectFindingView[];
  selectedFinding: ProjectFindingView | null;
  spec: ProjectSpecView | null;
  runs: ProjectRunView[];
  approvals: ProjectApprovalView[];
  pendingApproval: ProjectApprovalView | null;
  repository: { fullName: string; url: string | null; visibility: string } | null;
  deployment: { url: string; health: string } | null;
  schedulesEnabled: number;
}

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : null;
}

function records(value: unknown): JsonRecord[] {
  return Array.isArray(value) ? value.map(record).filter((item): item is JsonRecord => item !== null) : [];
}

function text(value: unknown, fallback = "") {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function optionalText(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numeric(value: unknown, fallback = 0) {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
}

function boundedTen(value: unknown) {
  const parsed = numeric(value);
  const tenPoint = parsed > 10 ? parsed / 10 : parsed;
  return Math.round(Math.max(0, Math.min(10, tenPoint)) * 10) / 10;
}

function normalizeMode(value: unknown): ViewSourceMode {
  const mode = text(value, "fixture").toLowerCase();
  if (mode.includes("import")) return "import";
  if (mode.includes("reddit") || mode === "live") return "live";
  return "fixture";
}

function normalizeStatus(value: unknown) {
  return text(value, "draft").toLowerCase();
}

function normalizeEvidence(raw: JsonRecord, fallbackSource: string) {
  return {
    id: text(raw.id, `evidence-${text(raw.sourceExternalId, "source")}`),
    quote: text(raw.quote, text(raw.excerpt, "Evidence excerpt is unavailable.")),
    source: text(raw.source, fallbackSource),
    sourceId: text(raw.sourceExternalId, text(raw.id, "source record")),
    attribution: text(raw.attribution, "Attribution retained with the source record"),
    permalink: optionalText(raw.permalink),
  };
}

function normalizeFinding(raw: JsonRecord, rank: number, fallbackSource: string): ProjectFindingView {
  const evidence = records(raw.excerpts ?? raw.evidence).map((item) => normalizeEvidence(item, fallbackSource));
  const scores = {
    frequency: boundedTen(raw.frequency ?? raw.frequencyScore),
    urgency: boundedTen(raw.urgency ?? raw.severityScore),
    willingness: boundedTen(raw.willingnessToPay ?? raw.willingnessToPayScore),
    buildability: boundedTen(raw.feasibilityScore ?? raw.score ?? raw.totalScore),
  } satisfies Record<FindingScoreKey, number>;
  const overall = boundedTen(raw.score ?? raw.totalScore ?? Object.values(scores).reduce((sum, score) => sum + score, 0) / 4);
  return {
    id: text(raw.id, `finding-${rank}`),
    rank,
    title: text(raw.title, text(raw.problem, "Ranked problem")),
    summary: text(raw.problemSummary, text(raw.problem, text(raw.scoreExplanation, "No problem summary was retained."))),
    solution: optionalText(raw.solutionConcept ?? raw.proposedSolution),
    score: overall,
    scores,
    selected: Boolean(raw.selectedAt ?? raw.selected),
    evidence,
  };
}

function normalizeSpec(raw: JsonRecord | null): ProjectSpecView | null {
  if (!raw) return null;
  const content = record(raw.content) ?? raw;
  const stories = records(content.userStories).map((story) => {
    const need = text(story.need);
    const outcome = text(story.outcome);
    return need && outcome ? `${need} so ${outcome}` : need || outcome;
  }).filter(Boolean);
  const jobs = Array.isArray(raw.jobs) ? raw.jobs.map((item) => text(item)).filter(Boolean) : [];
  const scope = Array.isArray(content.inScope) ? content.inScope.map((item) => text(item)).filter(Boolean) : [];
  return {
    id: text(raw.id, "specification"),
    version: Math.max(1, Math.round(numeric(raw.version, 1))),
    status: normalizeStatus(raw.status),
    title: text(content.productName, text(raw.title, "Product specification")),
    oneLiner: text(content.oneLinePitch, text(raw.summary, "The current product specification is ready for review.")),
    targetUser: text(content.targetAudience, text(raw.audience, "Target audience not yet specified")),
    workflow: stories.length ? stories : jobs.length ? jobs : scope.slice(0, 4),
    hash: text(raw.contentHash, text(raw.hash, "hash unavailable")),
    updatedAt: optionalText(raw.updatedAt),
  };
}

function normalizeRun(raw: JsonRecord): ProjectRunView {
  const steps = records(raw.steps).map((step) => ({
    id: text(step.id, text(step.key, "step")),
    label: text(step.label, text(step.key, "Workflow step")),
    status: normalizeStatus(step.status),
    updatedAt: optionalText(step.finishedAt ?? step.startedAt ?? step.updatedAt),
  }));
  return {
    id: text(raw.id, "run"),
    kind: normalizeStatus(raw.kind),
    status: normalizeStatus(raw.status),
    currentStep: optionalText(raw.currentStep ?? raw.currentStepKey),
    actualCostMicros: numeric(raw.actualCostMicros ?? record(raw.budget)?.spentCents) * (record(raw.budget)?.spentCents !== undefined ? 10_000 : 1),
    updatedAt: optionalText(raw.updatedAt ?? raw.completedAt ?? raw.finishedAt ?? raw.startedAt ?? raw.createdAt),
    steps,
  };
}

function normalizeApproval(raw: JsonRecord): ProjectApprovalView {
  const payload = record(raw.payload);
  const cents = payload?.costCeilingCents;
  return {
    id: text(raw.id, "approval"),
    kind: normalizeStatus(raw.kind),
    status: normalizeStatus(raw.status),
    expiresAt: optionalText(raw.expiresAt),
    costCeilingMicros: payload?.costCeilingMicros !== undefined
      ? numeric(payload.costCeilingMicros)
      : cents !== undefined
        ? numeric(cents) * 10_000
        : null,
  };
}

export function normalizeProjectView(value: unknown, projectId: string): ProjectViewModel {
  const raw = record(value) ?? {};
  const sources = records(raw.sources);
  const sourceMode = normalizeMode(raw.sourceMode ?? raw.researchMode);
  const rawSourceLabel = text(raw.sourceLabel, text(sources[0]?.label, sourceMode === "import" ? "Authorized JSON import" : sourceMode === "live" ? "Reddit API source" : "Curated fixture dataset"));
  const sourceLabel = rawSourceLabel.startsWith("search:") ? "Reddit discovery search" : rawSourceLabel;
  const rawSpecs = records(raw.specVersions);
  const directSpec = record(raw.spec);
  const currentSpecId = optionalText(raw.currentSpecVersionId);
  const specRecord = currentSpecId ? rawSpecs.find((item) => item.id === currentSpecId) ?? rawSpecs[0] ?? directSpec : rawSpecs[0] ?? directSpec;
  const spec = normalizeSpec(specRecord ?? null);
  const selectedFindingId = optionalText(raw.selectedFindingId) ?? optionalText(specRecord?.basedOnFindingId);
  const findings = records(raw.findings).map((item, index) => normalizeFinding(item, index + 1, sourceLabel));
  const inferredSelectedId = selectedFindingId ?? findings.find((finding) => finding.selected)?.id ?? (spec ? findings[0]?.id : undefined);
  for (const finding of findings) finding.selected = finding.id === inferredSelectedId;
  const runs = records(raw.runs).map(normalizeRun);
  const approvals = records(raw.approvals).map(normalizeApproval);
  const status = normalizeStatus(raw.status);
  const latestApprovalId = optionalText(raw.latestApprovalId);
  const pendingApproval = approvals.find((approval) => approval.status === "pending")
    ?? (latestApprovalId && (status.includes("approval") || status === "needs_approval")
      ? { id: latestApprovalId, kind: status.includes("release") || spec?.status === "approved" ? "first_release" : "specification_build", status: "pending", expiresAt: null, costCeilingMicros: null }
      : null);
  const repositoryRaw = record(raw.repository);
  const deployments = records(raw.deployments);
  const deploymentRaw = record(raw.deployment) ?? deployments[0] ?? null;
  const schedules = records(raw.schedules);
  const inlineSchedules = record(raw.schedules);
  const schedulesEnabled = schedules.filter((schedule) => normalizeStatus(schedule.status) === "enabled").length
    + (inlineSchedules?.hourlyResearch === true ? 1 : 0)
    + (inlineSchedules?.fiveHourPolish === true ? 1 : 0);
  const blocker = optionalText(raw.currentBlocker ?? raw.blocker);
  const config = record(raw.config);
  const liveAuthorized = sourceMode === "live"
    && sources.some((source) => Boolean(source.authorizedAt))
    && !blocker?.toLowerCase().includes("authorization");

  return {
    id: text(raw.id, projectId),
    name: text(raw.name, "Workspace project"),
    marketLabel: text(raw.marketLabel, "Evidence-first product workspace"),
    status,
    blocker,
    nextAction: text(raw.nextAction, blocker ?? "Review project state"),
    optimisticVersion: Math.max(0, Math.round(numeric(raw.optimisticVersion ?? raw.version))),
    maxCostMicrosPerRun: Math.max(0, Math.round(numeric(config?.maxCostMicrosPerRun, 5_000_000))),
    updatedAt: optionalText(raw.updatedAt),
    sourceMode,
    sourceLabel,
    liveAuthorized,
    findings,
    selectedFinding: findings.find((finding) => finding.selected) ?? null,
    spec,
    runs,
    approvals,
    pendingApproval,
    repository: repositoryRaw ? {
      fullName: text(repositoryRaw.fullName, [text(repositoryRaw.owner), text(repositoryRaw.name)].filter(Boolean).join("/") || "Private repository"),
      url: optionalText(repositoryRaw.url),
      visibility: normalizeStatus(repositoryRaw.visibility || "private"),
    } : null,
    deployment: deploymentRaw ? {
      url: text(deploymentRaw.url, "Deployment URL unavailable"),
      health: normalizeStatus(deploymentRaw.health ?? deploymentRaw.status),
    } : null,
    schedulesEnabled,
  };
}

function readableStep(value: string | null) {
  if (!value) return "the last recorded build stage";
  return value.replace(/^build\./, "").replaceAll("_", " ").replaceAll(".", " ");
}

export function projectLifecycleFor(project: ProjectViewModel): ProjectLifecycle {
  const latestBuild = project.runs.find((run) => run.kind === "build" || run.kind === "polish") ?? null;
  const latestResearch = project.runs.find((run) => run.kind === "research") ?? null;
  const researchComplete = project.findings.length > 0;
  const selectionComplete = Boolean(project.selectedFinding);
  const specificationComplete = Boolean(project.spec);
  const specificationApproved = project.spec?.status === "approved";
  const buildComplete = latestBuild?.status === "succeeded"
    || ["awaiting_release_approval", "released", "live"].includes(project.status);
  const releaseComplete = ["released", "live"].includes(project.status);
  const completion = [true, researchComplete, selectionComplete, specificationComplete, specificationApproved, buildComplete, releaseComplete];
  const firstIncomplete = completion.findIndex((complete) => !complete);
  const currentIndex = firstIncomplete === -1 ? completion.length - 1 : firstIncomplete;
  const pendingSpecApproval = Boolean(project.pendingApproval?.kind.includes("specification")) || project.status === "awaiting_spec_approval";
  const pendingReleaseApproval = Boolean(project.pendingApproval?.kind.includes("release")) || project.status === "awaiting_release_approval";
  const baseStages: Array<Omit<ProjectLifecycleStage, "state">> = [
    { id: "define", label: "Define project", summary: `${project.marketLabel} · ${project.sourceLabel}`, href: `/projects/${project.id}/settings` },
    { id: "research", label: "Research", summary: researchComplete ? `${project.findings.length} ranked finding${project.findings.length === 1 ? "" : "s"}` : "Run bounded research against the approved source.", href: `/projects/${project.id}/evidence` },
    { id: "select", label: "Select evidence", summary: project.selectedFinding ? project.selectedFinding.title : "Choose one evidence-backed problem to carry forward.", href: `/projects/${project.id}/evidence` },
    { id: "specify", label: "Generate or edit ProductSpec", summary: project.spec ? `Version ${project.spec.version} · ${project.spec.oneLiner}` : "Turn the selected problem into an editable, versioned ProductSpec.", href: `/projects/${project.id}/spec` },
    { id: "approve-spec", label: "Approve specification", summary: specificationApproved ? `Approved · ${project.spec?.hash.slice(0, 12)}` : "An owner must approve the exact ProductSpec hash before building.", href: pendingSpecApproval ? "/approvals" : `/projects/${project.id}/spec` },
    { id: "build", label: "Build and verify", summary: buildComplete ? "The artifact passed clean-sandbox verification." : latestBuild ? `Build ${latestBuild.status.replaceAll("_", " ")} · ${readableStep(latestBuild.currentStep)}` : "Run one bounded builder and one fresh verifier sandbox.", href: `/projects/${project.id}/builds` },
    { id: "release", label: "Approve and release", summary: releaseComplete ? "The approved release is live." : pendingReleaseApproval ? "The verified artifact is waiting for owner approval." : "Review the signed preview before repository or deployment effects.", href: pendingReleaseApproval ? "/approvals" : `/projects/${project.id}/releases` },
  ];
  const stages = baseStages.map((stage, index): ProjectLifecycleStage => ({
    ...stage,
    state: index < currentIndex ? "complete" : index === currentIndex ? "current" : "upcoming",
  }));
  const current = stages[currentIndex]!;

  let blocker: string;
  if (project.status === "paused") blocker = "This project is paused. Resume it before starting another run.";
  else if (current.id === "research") blocker = "Research has not produced ranked evidence yet.";
  else if (current.id === "select") blocker = "Choose one evidence-backed problem before generating a ProductSpec.";
  else if (current.id === "specify") blocker = "Generate and edit a ProductSpec from the selected evidence.";
  else if (current.id === "approve-spec") blocker = "The ProductSpec needs owner approval before a build can start.";
  else if (current.id === "build" && latestBuild?.status === "failed") blocker = `The build stopped during ${readableStep(latestBuild.currentStep)}. Review consumed usage, then retry with the same approved ProductSpec.`;
  else if (current.id === "build" && latestBuild?.status === "canceled") blocker = "The prior build was canceled. Start a fresh attempt when the approved ProductSpec is still valid.";
  else if (current.id === "build") blocker = "The approved ProductSpec is ready for a bounded build and clean verification.";
  else if (pendingReleaseApproval) blocker = "The verified build needs owner approval before repository or deployment changes.";
  else blocker = "Review the signed preview and release record.";

  const primaryAction = current.id === "research"
    ? { label: latestResearch && ["queued", "running"].includes(latestResearch.status) ? "View research" : "Run research", href: `/projects/${project.id}/evidence`, kind: "research" as const }
    : current.id === "select"
      ? { label: "Select evidence", href: current.href, kind: "navigate" as const }
      : current.id === "specify"
        ? { label: "Generate ProductSpec", href: current.href, kind: "generate-spec" as const }
        : current.id === "approve-spec"
          ? { label: pendingSpecApproval ? "Review specification approval" : "Review ProductSpec", href: current.href, kind: "navigate" as const }
          : current.id === "build"
            ? { label: latestBuild?.status === "running" ? "View running build" : latestBuild?.status === "failed" || latestBuild?.status === "canceled" ? "Review and retry build" : "Open build control", href: current.href, kind: "navigate" as const }
            : { label: releaseComplete ? "View release" : "Review release approval", href: current.href, kind: "navigate" as const };

  return { stages, current, blocker, primaryAction };
}

export async function readProjectView(response: Response, projectId: string) {
  const body = await response.json().catch(() => null) as { data?: unknown; error?: { message?: string } } | null;
  if (!response.ok || !body || !("data" in body)) {
    throw new Error(body?.error?.message ?? `Project request failed (${response.status}).`);
  }
  return normalizeProjectView(body.data, projectId);
}

export function formatCompactDate(value: string | null) {
  if (!value) return "Not recorded";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Not recorded";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

export function formatExpiry(value: string | null) {
  if (!value) return "See review";
  const remaining = new Date(value).getTime() - Date.now();
  if (!Number.isFinite(remaining) || remaining <= 0) return "Expired";
  const hours = Math.floor(remaining / 3_600_000);
  const minutes = Math.floor((remaining % 3_600_000) / 60_000);
  return hours >= 24 ? `${Math.floor(hours / 24)}d ${hours % 24}h` : `${hours}h ${minutes}m`;
}

export function formatMoneyMicros(value: number | null) {
  if (value === null) return "Policy bound";
  return new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", minimumFractionDigits: 2 }).format(value / 1_000_000);
}
