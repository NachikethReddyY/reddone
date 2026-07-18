import "server-only";

import { getDb } from "./db";

export type ProjectLifecycleCommand = "project.pause" | "project.resume";

/** Shared command boundary for REST and conversation actions; no internal HTTP calls. */
export async function executeProjectLifecycleCommand(input: {
  workspaceId: string;
  projectId: string;
  expectedProjectVersion: number;
  command: ProjectLifecycleCommand;
}) {
  return getDb().$transaction(async (tx) => {
    const project = await tx.project.findUnique({
      where: { workspaceId_id: { workspaceId: input.workspaceId, id: input.projectId } },
      include: { deployments: { where: { lastKnownGood: true }, take: 1 }, specVersions: { orderBy: { version: "desc" }, take: 1 } },
    });
    if (!project || project.archivedAt || project.status === "ARCHIVED") throw new Error("Project not found.");
    if (project.optimisticVersion !== input.expectedProjectVersion) throw new Error("Project version conflict.");
    const desiredStatus = input.command === "project.pause" ? "PAUSED" as const : project.deployments.length
      ? "RELEASED" as const
      : project.specVersions[0]?.status === "APPROVED"
        ? "READY_TO_BUILD" as const
        : project.specVersions[0]?.status === "PENDING_APPROVAL"
          ? "AWAITING_SPEC_APPROVAL" as const
          : "DRAFT" as const;
    const updated = await tx.project.update({
      where: { id: project.id },
      data: {
        status: desiredStatus,
        ...(input.command === "project.pause" ? { currentBlocker: "Project paused by owner-confirmed action" } : { currentBlocker: null }),
        optimisticVersion: { increment: 1 },
      },
    });
    if (input.command === "project.pause") {
      await tx.schedule.updateMany({
        where: { workspaceId: input.workspaceId, projectId: input.projectId },
        data: { status: "PAUSED", nextRunAt: null, backoffUntil: null, optimisticVersion: { increment: 1 } },
      });
    }
    return { id: updated.id, status: updated.status.toLowerCase(), optimisticVersion: updated.optimisticVersion };
  });
}
