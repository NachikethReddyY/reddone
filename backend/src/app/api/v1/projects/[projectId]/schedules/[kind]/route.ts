import { z } from "zod";

import { getDb } from "@/server/db";
import { isDemoMode, isHackathonMode } from "@/server/env";
import { getDemoSchedule, getProject, readIdempotent, updateDemoSchedule, writeIdempotent } from "@/workflows/demo-store";
import { handleRouteError, HttpError, mutationContext, ok, requestId, route } from "@/workflows/http";

type Context = { params: Promise<{ projectId: string; kind: string }> };

function scheduleKind(value: string) {
  return z.enum(["hourly_research", "five_hour_polish"]).parse(value);
}

export async function GET(request: Request, { params }: Context) {
  const { projectId, kind: rawKind } = await params;
  return route(request, async () => {
    if (isHackathonMode()) throw new HttpError("feature_disabled", "Schedules are unavailable in hackathon mode.", 403);
    const kind = scheduleKind(rawKind);
    if (isDemoMode()) {
      if (!getProject(projectId)) throw new HttpError("not_found", "Project not found.", 404);
      return getDemoSchedule(projectId, kind);
    }
    const owner = await (await import("@/workflows/http")).assertOwnerRequest(request);
    const schedule = await getDb().schedule.findFirst({
      where: {
        workspaceId: owner.workspaceId,
        projectId,
        kind: kind === "hourly_research" ? "HOURLY_RESEARCH" : "FIVE_HOUR_POLISH",
      },
    });
    if (!schedule) throw new HttpError("not_found", "Schedule not found.", 404);
    return {
      id: schedule.id,
      projectId,
      kind,
      enabled: schedule.status !== "PAUSED",
      intervalMinutes: schedule.intervalMinutes,
      timeZone: schedule.timeZone,
      status: schedule.status.toLowerCase(),
      nextRunAt: schedule.nextRunAt?.toISOString() ?? null,
      lastEnqueuedAt: schedule.lastEnqueuedAt?.toISOString() ?? null,
      lastCompletedAt: schedule.lastCompletedAt?.toISOString() ?? null,
      backoffUntil: schedule.backoffUntil?.toISOString() ?? null,
      consecutiveFailures: schedule.consecutiveFailures,
      optimisticVersion: schedule.optimisticVersion,
    };
  });
}

export async function PATCH(request: Request, { params }: Context) {
  const id = requestId(request);
  try {
    const context = await mutationContext(request, { requireVersion: true });
    const { projectId, kind: rawKind } = await params;
    if (isHackathonMode()) throw new HttpError("feature_disabled", "Schedules are unavailable in hackathon mode.", 403);
    const kind = scheduleKind(rawKind);
    const body = z.object({ enabled: z.boolean(), optimisticVersion: z.number().int().nonnegative() }).strict().parse(await request.json());
    if (body.optimisticVersion !== context.expectedVersion) throw new HttpError("precondition_failed", "Schedule version conflict.", 412);
    if (isDemoMode()) {
      const cached = readIdempotent<ReturnType<typeof getDemoSchedule>>(context.idempotencyKey);
      if (cached) return ok(cached, context.requestId);
      if (!getProject(projectId)) throw new HttpError("not_found", "Project not found.", 404);
      let result: ReturnType<typeof getDemoSchedule>;
      try {
        result = updateDemoSchedule({ projectId, kind, enabled: body.enabled, expectedVersion: context.expectedVersion! });
      } catch (error) {
        if (error instanceof Error && /version conflict/i.test(error.message)) {
          throw new HttpError("precondition_failed", "Schedule version conflict.", 412);
        }
        throw error;
      }
      writeIdempotent(context.idempotencyKey, result);
      return ok(result, context.requestId);
    }
    const result = await getDb().schedule.updateMany({
      where: {
        workspaceId: context.owner.workspaceId,
        projectId,
        kind: kind === "hourly_research" ? "HOURLY_RESEARCH" : "FIVE_HOUR_POLISH",
        optimisticVersion: context.expectedVersion!,
      },
      data: {
        status: body.enabled ? "ENABLED" : "PAUSED",
        nextRunAt: body.enabled ? new Date(Date.now() + (kind === "hourly_research" ? 60 : 300) * 60_000) : null,
        backoffUntil: null,
        consecutiveFailures: 0,
        optimisticVersion: { increment: 1 },
      },
    });
    if (result.count !== 1) throw new HttpError("precondition_failed", "Schedule version conflict.", 412);
    const schedule = await getDb().schedule.findFirstOrThrow({
      where: { workspaceId: context.owner.workspaceId, projectId, kind: kind === "hourly_research" ? "HOURLY_RESEARCH" : "FIVE_HOUR_POLISH" },
    });
    return ok(schedule, context.requestId);
  } catch (error) {
    return handleRouteError(error, id);
  }
}
