import type { ProjectConfig } from "@/contracts/project";

export type Provider = "kimi" | "daytona" | "reddit" | "github" | "vercel";
export type RunKind = "research" | "build" | "polish" | "release" | "rollback";
export type RunStatus = "queued" | "running" | "awaiting_approval" | "succeeded" | "failed" | "canceled";

export interface RuntimeConnection {
  provider: Provider;
  mode: "demo" | "live" | "disabled";
  status: "healthy" | "untested" | "disconnected" | "degraded" | "locked";
  account: string | null;
  scopes: string[];
  maskedSuffix: string | null;
  lastTestedAt: string | null;
  message: string;
  optimisticVersion: number;
}

export interface RuntimeFinding {
  id: string;
  title: string;
  problem: string;
  score: number;
  frequency: number;
  urgency: number;
  willingnessToPay: number;
  excerpts: Array<{ id: string; quote: string; source: string; permalink: string; score: number }>;
}

export interface RuntimeSpec {
  id: string;
  version: number;
  status: "draft" | "approved" | "superseded";
  title: string;
  summary: string;
  audience: string;
  jobs: string[];
  features: Array<{ name: string; description: string; acceptance: string[] }>;
  nonGoals: string[];
  hash: string;
  updatedAt: string;
}

export interface RuntimeApproval {
  id: string;
  projectId: string;
  kind: "specification_build" | "first_release" | "polish_release" | "secret_grant" | "rollback";
  status: "pending" | "approved" | "rejected" | "expired" | "consumed";
  title: string;
  summary: string;
  payload: Record<string, unknown>;
  payloadHash: string;
  optimisticVersion: number;
  expiresAt: string;
  createdAt: string;
  resolvedAt: string | null;
  reason: string | null;
  upstreamLabel: string;
}

export interface RuntimeEvent {
  id: number;
  runId: string;
  level: "info" | "success" | "warning" | "error";
  type: string;
  message: string;
  createdAt: string;
}

export interface RuntimeRun {
  id: string;
  projectId: string;
  kind: RunKind;
  status: RunStatus;
  mode: "demo" | "live" | "import";
  currentStep: string;
  progress: number;
  startedAt: string;
  completedAt: string | null;
  budget: { reservedCents: number; spentCents: number; modelTurns: number; maxModelTurns: number };
  artifactHash: string | null;
  previewUrl: string | null;
  cancelRequested: boolean;
  version: number;
}

export interface RuntimeProject {
  id: string;
  name: string;
  marketLabel: string;
  sourceMode: "fixture" | "import" | "reddit";
  sourceLabel: string;
  config: ProjectConfig;
  status: "researching" | "needs_approval" | "building" | "release_ready" | "live" | "paused";
  blocker: string | null;
  nextAction: string;
  timezone: string;
  updatedAt: string;
  version: number;
  selectedFindingId: string | null;
  findings: RuntimeFinding[];
  spec: RuntimeSpec | null;
  latestRunId: string | null;
  latestApprovalId: string | null;
  repository: {
    fullName: string;
    url: string;
    visibility: "private";
    defaultBranch: string;
    installationId: string;
    lastCommitSha: string;
  } | null;
  deployment: {
    id: string;
    externalProjectId: string;
    externalDeploymentId: string;
    teamId: string;
    artifactHash: string;
    url: string;
    healthCheckUrl: string;
    health: "healthy" | "degraded";
    lastKnownGoodUrl: string;
    createdAt: string;
    promotedAt: string;
  } | null;
  schedules: { hourlyResearch: boolean; fiveHourPolish: boolean; nextResearchAt: string | null; nextPolishAt: string | null };
  scheduleVersions: { hourlyResearch: number; fiveHourPolish: number };
}
