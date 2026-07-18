import "server-only";

import { z } from "zod";

import { getDb } from "@/server/db";

const EmptyInputSchema = z.object({}).strict();
const ProjectSummarySchema = z.object({
  name: z.string().max(120),
  status: z.string().max(64),
  lifecycleBlocker: z.string().max(500).nullable(),
  selectedFinding: z.string().max(200).nullable(),
  specStatus: z.string().max(64).nullable(),
  latestRunStatus: z.string().max(64).nullable(),
  pendingApprovals: z.number().int().nonnegative().max(100),
  runtimeSecretsReady: z.boolean(),
  providerReadiness: z.object({ kimi: z.boolean(), daytona: z.boolean() }).strict(),
}).strict();

export type SafeProjectContext = z.infer<typeof ProjectSummarySchema>;

/**
 * Static trusted project reads. Tool callers never supply workspace or project IDs,
 * preventing model-directed tenant traversal and arbitrary repository access.
 */
export async function readSafeProjectContext(input: { workspaceId: string; projectId: string }): Promise<SafeProjectContext> {
  const project = await getDb().project.findUnique({
    where: { workspaceId_id: { workspaceId: input.workspaceId, id: input.projectId } },
    include: {
      findings: { where: { selectedAt: { not: null } }, select: { title: true }, take: 1 },
      specVersions: { orderBy: { version: "desc" }, select: { status: true }, take: 1 },
      runs: { orderBy: { createdAt: "desc" }, select: { status: true }, take: 1 },
      approvals: { where: { status: "PENDING" }, select: { id: true } },
      secretVersions: { where: { scope: "PROJECT_RUNTIME", revokedAt: null }, select: { id: true }, take: 1 },
    },
  });
  if (!project) throw new Error("Project not found.");
  const providers = await getDb().providerConnection.findMany({
    where: { workspaceId: input.workspaceId, provider: { in: ["KIMI", "DAYTONA"] }, health: "HEALTHY" },
    select: { provider: true },
  });
  return ProjectSummarySchema.parse({
    name: project.name,
    status: project.status.toLowerCase(),
    lifecycleBlocker: project.currentBlocker,
    selectedFinding: project.findings[0]?.title ?? null,
    specStatus: project.specVersions[0]?.status.toLowerCase() ?? null,
    latestRunStatus: project.runs[0]?.status.toLowerCase() ?? null,
    pendingApprovals: project.approvals.length,
    runtimeSecretsReady: project.secretVersions.length > 0,
    providerReadiness: { kimi: providers.some((item) => item.provider === "KIMI"), daytona: providers.some((item) => item.provider === "DAYTONA") },
  });
}

export const projectReadToolRegistry = [{
  name: "project_summary",
  input: EmptyInputSchema,
  output: ProjectSummarySchema,
  maxOutputBytes: 8_000,
  execute: readSafeProjectContext,
}] as const;
