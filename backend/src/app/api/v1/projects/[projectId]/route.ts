import { z } from "zod";

import { ProjectConfigSchema } from "@/contracts";
import { getDb } from "@/server/db";
import { isDemoMode } from "@/server/env";
import { getWorkspaceProject } from "@/server/project-repository";
import { demoStore, getProject, normalizeDemoProjectId, readIdempotent, writeIdempotent } from "@/workflows/demo-store";
import { handleRouteError, HttpError, mutationContext, ok, requestId, route } from "@/workflows/http";

type Context = { params: Promise<{ projectId: string }> };

export async function GET(request: Request, { params }: Context) {
  const { projectId } = await params;
  return route(request, async () => {
    if (!isDemoMode()) {
      const owner = await (await import("@/workflows/http")).assertOwnerRequest(request);
      const project = await getWorkspaceProject(owner.workspaceId, projectId);
      if (!project) throw new HttpError("not_found", "Project not found.", 404);
      return project;
    }
    const project = getProject(projectId);
    if (!project) throw new HttpError("not_found", "Project not found.", 404);
    return {
      ...project,
      runs: [...demoStore.runs.values()]
        .filter((run) => run.projectId === project.id)
        .sort((left, right) => right.startedAt.localeCompare(left.startedAt)),
    };
  });
}

export async function PATCH(request: Request, { params }: Context) {
  const id = requestId(request);
  try {
    const context = await mutationContext(request, { requireVersion: true });
    const cached = readIdempotent<unknown>(context.idempotencyKey);
    if (cached) return ok(cached, context.requestId);
    const { projectId } = await params;
    if (!isDemoMode()) {
      const body = z
        .object({
          name: z.string().trim().min(2).max(120).optional(),
          marketLabel: z.string().trim().min(2).max(120).optional(),
          researchContext: z.string().trim().min(1).max(5_000).optional(),
          maxDocumentsPerRun: z.number().int().min(1).max(1_000).optional(),
          maxCostMicrosPerRun: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
          status: z.enum(["paused", "active"]).optional(),
          authorityMode: z.enum(["read_only", "review", "autopilot"]).optional(),
          schedules: z.object({ hourlyResearch: z.boolean().optional(), fiveHourPolish: z.boolean().optional() }).optional(),
        })
        .strict()
        .parse(await request.json());
      const updated = await getDb().$transaction(async (tx) => {
        const current = await tx.project.findFirst({
          where: { id: projectId, workspaceId: context.owner.workspaceId },
          include: { deployments: { where: { lastKnownGood: true }, take: 1 } },
        });
        if (!current || current.optimisticVersion !== context.expectedVersion) {
          throw new HttpError("precondition_failed", "Project version conflict.", 412);
        }
        const currentConfig = ProjectConfigSchema.parse(current.config);
        const config = ProjectConfigSchema.parse({
          ...currentConfig,
          ...(body.marketLabel ? { marketLabel: body.marketLabel } : {}),
          ...(body.researchContext ? { researchContext: body.researchContext } : {}),
          ...(body.maxDocumentsPerRun !== undefined ? { maxDocumentsPerRun: body.maxDocumentsPerRun } : {}),
          ...(body.maxCostMicrosPerRun !== undefined ? { maxCostMicrosPerRun: body.maxCostMicrosPerRun } : {}),
        });
        const currentSpec = current.currentSpecVersionId
          ? await tx.productSpecVersion.findUnique({ where: { id: current.currentSpecVersionId } })
          : null;
        const resumedStatus = current.deployments.length
          ? "RELEASED" as const
          : currentSpec?.status === "APPROVED"
            ? "READY_TO_BUILD" as const
            : currentSpec?.status === "PENDING_APPROVAL"
              ? "AWAITING_SPEC_APPROVAL" as const
              : "DRAFT" as const;
        const result = await tx.project.update({
          where: { id: current.id },
          data: {
            ...(body.name ? { name: body.name } : {}),
            marketLabel: config.marketLabel,
            researchContext: config.researchContext,
            config,
            ...(body.status ? { status: body.status === "paused" ? "PAUSED" as const : resumedStatus } : {}),
            ...(body.authorityMode ? { authorityMode: body.authorityMode.toUpperCase() as "READ_ONLY" | "REVIEW" | "AUTOPILOT" } : {}),
            ...(body.status === "active" ? { currentBlocker: null } : {}),
            optimisticVersion: { increment: 1 },
          },
        });
        if (body.schedules?.hourlyResearch !== undefined) {
          await tx.schedule.update({
            where: { projectId_kind: { projectId, kind: "HOURLY_RESEARCH" } },
            data: {
              status: body.schedules.hourlyResearch ? "ENABLED" : "PAUSED",
              nextRunAt: body.schedules.hourlyResearch ? new Date(Date.now() + 60 * 60_000) : null,
              optimisticVersion: { increment: 1 },
            },
          });
        }
        if (body.schedules?.fiveHourPolish !== undefined) {
          await tx.schedule.update({
            where: { projectId_kind: { projectId, kind: "FIVE_HOUR_POLISH" } },
            data: {
              status: body.schedules.fiveHourPolish ? "ENABLED" : "PAUSED",
              nextRunAt: body.schedules.fiveHourPolish ? new Date(Date.now() + 5 * 60 * 60_000) : null,
              optimisticVersion: { increment: 1 },
            },
          });
        }
        if (body.status === "paused") {
          await tx.schedule.updateMany({
            where: { workspaceId: context.owner.workspaceId, projectId },
            data: { status: "PAUSED", nextRunAt: null, backoffUntil: null, optimisticVersion: { increment: 1 } },
          });
        }
        if (body.authorityMode) {
          await tx.auditEvent.create({
            data: {
              workspaceId: context.owner.workspaceId,
              actorUserId: context.owner.userId,
              action: "project.authority_mode.updated",
              targetType: "project",
              targetId: projectId,
              requestId: context.requestId,
              metadata: { authorityMode: body.authorityMode },
              expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60_000),
            },
          });
        }
        return result;
      });
      return ok(updated, context.requestId);
    }
    const project = getProject(projectId);
    if (!project) throw new HttpError("not_found", "Project not found.", 404);
    if (project.version !== context.expectedVersion) {
      throw new HttpError("precondition_failed", "Project version conflict.", 412, false, { currentVersion: project.version });
    }
    const body = z
      .object({
          name: z.string().trim().min(2).max(120).optional(),
          marketLabel: z.string().trim().min(2).max(120).optional(),
          researchContext: z.string().trim().min(1).max(5_000).optional(),
          maxDocumentsPerRun: z.number().int().min(1).max(1_000).optional(),
          maxCostMicrosPerRun: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
          status: z.enum(["paused", "active"]).optional(),
          authorityMode: z.enum(["read_only", "review", "autopilot"]).optional(),
        schedules: z
          .object({ hourlyResearch: z.boolean().optional(), fiveHourPolish: z.boolean().optional() })
          .optional(),
      })
      .strict()
      .parse(await request.json());
    if (body.name) project.name = body.name;
    project.config = ProjectConfigSchema.parse({
      ...project.config,
      ...(body.marketLabel ? { marketLabel: body.marketLabel } : {}),
      ...(body.researchContext ? { researchContext: body.researchContext } : {}),
      ...(body.maxDocumentsPerRun !== undefined ? { maxDocumentsPerRun: body.maxDocumentsPerRun } : {}),
      ...(body.maxCostMicrosPerRun !== undefined ? { maxCostMicrosPerRun: body.maxCostMicrosPerRun } : {}),
    });
    project.marketLabel = project.config.marketLabel;
    if (body.status) {
      project.status = body.status === "paused" ? "paused" : project.deployment ? "live" : project.spec?.status === "approved" ? "release_ready" : "researching";
      if (body.status === "paused") {
        project.scheduleVersions.hourlyResearch += 1;
        project.scheduleVersions.fiveHourPolish += 1;
        project.schedules = { hourlyResearch: false, fiveHourPolish: false, nextResearchAt: null, nextPolishAt: null };
        project.config.hourlyResearchEnabled = false;
        project.config.fiveHourPolishEnabled = false;
      }
    }
    if (body.schedules) {
      if (body.schedules.hourlyResearch !== undefined) {
        project.scheduleVersions.hourlyResearch += 1;
        project.config.hourlyResearchEnabled = body.schedules.hourlyResearch;
      }
      if (body.schedules.fiveHourPolish !== undefined) {
        project.scheduleVersions.fiveHourPolish += 1;
        project.config.fiveHourPolishEnabled = body.schedules.fiveHourPolish;
      }
      project.schedules = {
        ...project.schedules,
        ...(body.schedules.hourlyResearch !== undefined ? { hourlyResearch: body.schedules.hourlyResearch } : {}),
        ...(body.schedules.fiveHourPolish !== undefined ? { fiveHourPolish: body.schedules.fiveHourPolish } : {}),
        nextResearchAt:
          body.schedules.hourlyResearch === undefined
            ? project.schedules.nextResearchAt
            : body.schedules.hourlyResearch
              ? new Date(Date.now() + 3_600_000).toISOString()
              : null,
        nextPolishAt:
          body.schedules.fiveHourPolish === undefined
            ? project.schedules.nextPolishAt
            : body.schedules.fiveHourPolish
              ? new Date(Date.now() + 5 * 3_600_000).toISOString()
              : null,
      };
    }
    project.version += 1;
    project.updatedAt = new Date().toISOString();
    writeIdempotent(context.idempotencyKey, project);
    return ok(project, context.requestId);
  } catch (error) {
    return handleRouteError(error, id);
  }
}

export async function DELETE(request: Request, { params }: Context) {
  const id = requestId(request);
  try {
    const context = await mutationContext(request, { requireVersion: true });
    const { projectId } = await params;
    if (!isDemoMode()) {
      await getDb().$transaction(async (tx) => {
        const result = await tx.project.updateMany({
          where: { id: projectId, workspaceId: context.owner.workspaceId, optimisticVersion: context.expectedVersion! },
          data: { status: "ARCHIVED", archivedAt: new Date(), optimisticVersion: { increment: 1 } },
        });
        if (result.count !== 1) throw new HttpError("precondition_failed", "Project version conflict.", 412);
        await tx.schedule.updateMany({
          where: { workspaceId: context.owner.workspaceId, projectId },
          data: { status: "PAUSED", nextRunAt: null, backoffUntil: null, optimisticVersion: { increment: 1 } },
        });
        await tx.projectSecretGrant.updateMany({
          where: { workspaceId: context.owner.workspaceId, projectId, status: { in: ["PENDING", "ACTIVE"] } },
          data: { status: "REVOKED", revokedAt: new Date() },
        });
      });
      return ok({ deleted: true, archived: true, projectId }, context.requestId);
    }
    const project = getProject(projectId);
    if (!project) throw new HttpError("not_found", "Project not found.", 404);
    if (project.version !== context.expectedVersion) throw new HttpError("precondition_failed", "Project version conflict.", 412);
    demoStore.projects.delete(normalizeDemoProjectId(projectId));
    const result = { deleted: true, projectId: normalizeDemoProjectId(projectId) };
    writeIdempotent(context.idempotencyKey, result);
    return ok(result, context.requestId);
  } catch (error) {
    return handleRouteError(error, id);
  }
}
