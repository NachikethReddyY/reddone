import "server-only";

import { createHash } from "node:crypto";

import type { ProjectCreateInput, ResearchPacket } from "@/contracts";
import { putImmutableArtifact } from "@/integrations/artifact-store";

import { getBackendRedditResidentialCredentials } from "./backend-providers";
import { getDb } from "./db";

export async function listWorkspaceProjects(workspaceId: string) {
  const projects = await getDb().project.findMany({
    where: { workspaceId, archivedAt: null },
    include: {
      runs: { orderBy: { createdAt: "desc" }, take: 1 },
      deployments: { where: { status: "HEALTHY" }, orderBy: { createdAt: "desc" }, take: 1 },
      schedules: { where: { status: "ENABLED" }, orderBy: { nextRunAt: "asc" } },
      findings: { orderBy: { totalScore: "desc" }, take: 1 },
    },
    orderBy: { updatedAt: "desc" },
  });
  return projects.map((project) => ({
    id: project.id,
    name: project.name,
    slug: project.slug,
    status: project.status.toLowerCase(),
    marketLabel: project.marketLabel,
    currentBlocker: project.currentBlocker,
    latestEvidenceSummary: project.findings[0]?.problemSummary ?? null,
    latestRunId: project.runs[0]?.id ?? null,
    latestRunStatus: project.runs[0]?.status.toLowerCase() ?? null,
    liveUrl: project.deployments[0]?.url ?? null,
    nextAction: project.currentBlocker ?? projectStatusNextAction(project.status),
    nextScheduledAt: project.schedules[0]?.nextRunAt?.toISOString() ?? null,
    optimisticVersion: project.optimisticVersion,
    createdAt: project.createdAt.toISOString(),
    updatedAt: project.updatedAt.toISOString(),
  }));
}

function projectStatusNextAction(status: string) {
  const actions: Record<string, string> = {
    DRAFT: "Add an authorized research source",
    RESEARCHING: "Inspect the active research run",
    AWAITING_SPEC_APPROVAL: "Review the proposed product specification",
    READY_TO_BUILD: "Start an isolated build",
    BUILDING: "Inspect build verification",
    AWAITING_RELEASE_APPROVAL: "Review the verified release payload",
    RELEASED: "Review new evidence before proposing polish",
    PAUSED: "Resume the project when ready",
    FAILED: "Inspect the failed run and retry safely",
  };
  return actions[status] ?? "Review project state";
}

export async function getWorkspaceProject(workspaceId: string, projectId: string) {
  return getDb().project.findUnique({
    where: { workspaceId_id: { workspaceId, id: projectId } },
    include: {
      sources: true,
      findings: { include: { evidence: true }, orderBy: { totalScore: "desc" } },
      specVersions: { orderBy: { version: "desc" } },
      runs: { include: { steps: { orderBy: { createdAt: "asc" } } }, orderBy: { createdAt: "desc" }, take: 25 },
      approvals: { orderBy: { createdAt: "desc" }, take: 25 },
      repository: true,
      deployments: { orderBy: { createdAt: "desc" }, take: 25 },
      schedules: true,
    },
  });
}

export async function createWorkspaceProject(workspaceId: string, input: ProjectCreateInput) {
  const db = getDb();
  const redditCredentials = input.config.researchMode === "live_reddit"
    ? getBackendRedditResidentialCredentials()
    : null;
  return db.$transaction(async (tx) => {
    const project = await tx.project.create({
      data: {
        workspaceId,
        name: input.name,
        slug: input.slug,
        marketLabel: input.config.marketLabel,
        researchContext: input.config.researchContext,
        researchMode:
          input.config.researchMode === "authorized_import"
            ? "AUTHORIZED_IMPORT"
            : input.config.researchMode === "live_reddit"
              ? "LIVE_REDDIT"
              : "FIXTURE",
        config: input.config,
        status: "DRAFT",
        currentBlocker: null,
        sources: {
          create:
            input.config.sourceLabels.length > 0
              ? input.config.sourceLabels.map((label) => ({
                  workspaceId,
                  mode:
                    input.config.researchMode === "authorized_import"
                      ? "AUTHORIZED_IMPORT" as const
                      : input.config.researchMode === "live_reddit"
                        ? "LIVE_REDDIT" as const
                        : "FIXTURE" as const,
                  label,
                  ...(input.config.researchMode === "live_reddit"
                    ? { authorizationReference: redditCredentials!.approvalReference, authorizedAt: new Date() }
                    : {}),
                }))
              : [
                  {
                    workspaceId,
                    mode: input.config.researchMode === "authorized_import" ? "AUTHORIZED_IMPORT" as const : "FIXTURE" as const,
                    label: input.config.researchMode === "authorized_import" ? "Authorized JSON import" : "LatePay fixture",
                  },
                ],
        },
      },
    });
    await tx.schedule.createMany({
      data: [
        {
          workspaceId,
          projectId: project.id,
          kind: "HOURLY_RESEARCH",
          status: input.config.hourlyResearchEnabled ? "ENABLED" : "PAUSED",
          intervalMinutes: 60,
          timeZone: input.config.workspaceTimeZone,
          nextRunAt: input.config.hourlyResearchEnabled ? new Date(Date.now() + 60 * 60_000) : null,
        },
        {
          workspaceId,
          projectId: project.id,
          kind: "FIVE_HOUR_POLISH",
          status: input.config.fiveHourPolishEnabled ? "ENABLED" : "PAUSED",
          intervalMinutes: 300,
          timeZone: input.config.workspaceTimeZone,
          nextRunAt: input.config.fiveHourPolishEnabled ? new Date(Date.now() + 5 * 60 * 60_000) : null,
        },
      ],
    });
    return project;
  });
}

export async function storeAuthorizedImport(input: {
  workspaceId: string;
  projectId: string;
  packet: ResearchPacket;
  raw: Uint8Array;
  expectedProjectVersion: number;
  allowRecoveredImport?: boolean;
}) {
  const contentHash = createHash("sha256").update(input.raw).digest("hex");
  const db = getDb();
  const existing = await db.researchImport.findUnique({
    where: { workspaceId_projectId_contentHash: { workspaceId: input.workspaceId, projectId: input.projectId, contentHash } },
  });
  if (existing) {
    if (!input.allowRecoveredImport) {
      const project = await db.project.findUnique({
        where: { workspaceId_id: { workspaceId: input.workspaceId, id: input.projectId } },
        select: { optimisticVersion: true },
      });
      if (!project) throw new Error("Project not found.");
      if (project.optimisticVersion !== input.expectedProjectVersion) throw new Error("Project version conflict.");
    }
    return existing;
  }
  const object = await putImmutableArtifact({
    workspaceId: input.workspaceId,
    kind: "research-import",
    body: input.raw,
    contentType: "application/json",
    expectedSha256: contentHash,
  });
  return db.$transaction(async (tx) => {
    const project = await tx.project.findUnique({
      where: { workspaceId_id: { workspaceId: input.workspaceId, id: input.projectId } },
    });
    if (!project) throw new Error("Project not found.");
    if (project.optimisticVersion !== input.expectedProjectVersion) throw new Error("Project version conflict.");
    let source = await tx.researchSource.findFirst({
      where: { workspaceId: input.workspaceId, projectId: input.projectId, mode: "AUTHORIZED_IMPORT", status: "ACTIVE" },
    });
    source ??= await tx.researchSource.create({
      data: {
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        mode: "AUTHORIZED_IMPORT",
        label: input.packet.sourceLabel,
        authorizationReference: input.packet.authorizationReference,
        authorizedAt: new Date(),
      },
    });
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60_000);
    const imported = await tx.researchImport.create({
      data: {
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        sourceId: source.id,
        status: "ACCEPTED",
        schemaVersion: input.packet.schemaVersion,
        objectKey: object.key,
        contentHash,
        documentCount: input.packet.documents.length,
        byteSize: input.raw.byteLength,
        rawExpiresAt: expiresAt,
        acceptedAt: new Date(),
      },
    });
    await tx.researchDocument.createMany({
      data: input.packet.documents.map((document) => ({
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        sourceId: source!.id,
        importId: imported.id,
        externalId: document.externalId,
        title: document.title,
        body: document.body,
        permalink: document.permalink ?? null,
        attribution: document.attribution,
        contentHash: createHash("sha256").update(`${document.title}\0${document.body}`).digest("hex"),
        sourcePublishedAt: document.publishedAt ? new Date(document.publishedAt) : null,
        rawExpiresAt: expiresAt,
        metadata: document.metadata,
      })),
      skipDuplicates: true,
    });
    await tx.project.update({
      where: { id: input.projectId, workspaceId: input.workspaceId, optimisticVersion: input.expectedProjectVersion },
      data: {
        researchMode: "AUTHORIZED_IMPORT",
        status: "DRAFT",
        currentBlocker: null,
        optimisticVersion: { increment: 1 },
      },
    });
    return imported;
  });
}
