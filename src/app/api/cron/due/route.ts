import { listProjects } from "@/workflows/demo-store";
import { apiError, ok, requestId } from "@/workflows/http";
import { getDb } from "@/server/db";
import { AppError } from "@/server/errors";
import { decideDueSchedule, failureBackoffUntil } from "@/server/schedule";
import { createProductionRun, dispatchProductionRun, reconcileWorkflowOutbox } from "@/workflows/production-run";
import { ProjectConfigSchema } from "@/contracts";
import { reconcilePendingCancellations } from "@/workflows/cancellation";
import { reconcileConversationOutbox } from "@/workflows/conversation-dispatch";
import { isDemoMode, isHackathonMode } from "@/server/env";

export async function GET(request: Request) {
  const id = requestId(request);
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return apiError(id, "forbidden", "Invalid cron authorization.", 403);
  }
  if (!isDemoMode()) {
    const db = getDb();
    // Cancellation reconciliation runs before new schedule claims so sandbox and
    // lease capacity is released only after durable shutdown is proven.
    const cancellations = await reconcilePendingCancellations(50);
    const outbox = await reconcileWorkflowOutbox(50);
    const conversations = await reconcileConversationOutbox(50);
    if (isHackathonMode()) {
      return ok({ enqueued: [], count: 0, schedulesDisabled: true, outbox, conversations, cancellations }, id);
    }
    const schedules = await db.schedule.findMany({
      where: { status: { in: ["ENABLED", "BACKING_OFF"] }, nextRunAt: { lte: new Date() } },
      include: { project: { select: { currentSpecVersionId: true, config: true, optimisticVersion: true } } },
      orderBy: { nextRunAt: "asc" },
      take: 100,
    });
    const enqueued: Array<{ scheduleId: string; projectId: string; runId?: string; error?: string }> = [];
    for (const schedule of schedules) {
      const kind = schedule.kind === "HOURLY_RESEARCH" ? "hourly_research" : "five_hour_polish";
      const decision = decideDueSchedule(
        {
          kind,
          enabled: schedule.status !== "PAUSED",
          nextRunAt: schedule.nextRunAt,
          consecutiveFailures: schedule.consecutiveFailures,
          backoffUntil: schedule.backoffUntil,
        },
        new Date(),
      );
      if (!decision.enqueue || !decision.scheduledFor || !decision.nextRunAt) continue;
      const scheduleHash = `${schedule.id}:${decision.scheduledFor.toISOString()}`;
      try {
        const claimed = await db.schedule.updateMany({
          where: { id: schedule.id, optimisticVersion: schedule.optimisticVersion, nextRunAt: schedule.nextRunAt },
          data: {
            status: "ENABLED",
            lastEnqueuedAt: new Date(),
            nextRunAt: decision.nextRunAt,
            backoffUntil: null,
            optimisticVersion: { increment: 1 },
          },
        });
        if (claimed.count !== 1) continue;
        const projectConfig = ProjectConfigSchema.parse(schedule.project.config);
        const requestedBudget = schedule.kind === "HOURLY_RESEARCH" ? 5_000_000 : 7_500_000;
        const created = await createProductionRun({
          workspaceId: schedule.workspaceId,
          projectId: schedule.projectId,
          kind: schedule.kind === "HOURLY_RESEARCH" ? "research" : "polish",
          ...(schedule.kind === "FIVE_HOUR_POLISH" && schedule.project.currentSpecVersionId
            ? { specVersionId: schedule.project.currentSpecVersionId }
            : {}),
          budgetCeilingMicros: Math.min(requestedBudget, projectConfig.maxCostMicrosPerRun),
          idempotencyKey: `schedule:${scheduleHash}`,
          scheduleId: schedule.id,
          expectedProjectVersion: schedule.project.optimisticVersion,
        });
        await dispatchProductionRun(schedule.workspaceId, created.run.id);
        enqueued.push({ scheduleId: schedule.id, projectId: schedule.projectId, runId: created.run.id });
      } catch (error) {
        if (error instanceof AppError && error.code === "insufficient_credits") {
          await db.schedule.update({
            where: { id: schedule.id },
            data: {
              status: "BLOCKED",
              blockerCode: error.code,
              blockerMessage: error.message.slice(0, 500),
              blockedAt: new Date(),
              backoffUntil: null,
              nextRunAt: null,
              optimisticVersion: { increment: 1 },
            },
          });
          enqueued.push({ scheduleId: schedule.id, projectId: schedule.projectId, error: error.message.slice(0, 300) });
          continue;
        }
        const failures = schedule.consecutiveFailures + 1;
        const backoffUntil = failureBackoffUntil(kind, failures);
        await db.schedule.update({
          where: { id: schedule.id },
          data: {
            status: "BACKING_OFF",
            consecutiveFailures: failures,
            backoffUntil,
            nextRunAt: backoffUntil,
            optimisticVersion: { increment: 1 },
          },
        });
        enqueued.push({
          scheduleId: schedule.id,
          projectId: schedule.projectId,
          error: error instanceof Error ? error.message.slice(0, 300) : "enqueue failed",
        });
      }
    }
    return ok({ enqueued, count: enqueued.filter((item) => item.runId).length, coalesced: true, outbox, conversations, cancellations }, id);
  }
  const current = Date.now();
  const due = listProjects().flatMap((project) => {
    const items: Array<{ projectId: string; kind: "research" | "polish"; scheduleHash: string }> = [];
    if (project.schedules.hourlyResearch && project.schedules.nextResearchAt && Date.parse(project.schedules.nextResearchAt) <= current) {
      items.push({ projectId: project.id, kind: "research", scheduleHash: `${project.id}:research:${project.schedules.nextResearchAt}` });
    }
    if (project.schedules.fiveHourPolish && project.schedules.nextPolishAt && Date.parse(project.schedules.nextPolishAt) <= current) {
      items.push({ projectId: project.id, kind: "polish", scheduleHash: `${project.id}:polish:${project.schedules.nextPolishAt}` });
    }
    return items;
  });
  // This endpoint only identifies/enqueues stable IDs. It never performs research or a build inline.
  return ok({ enqueued: due, count: due.length, coalesced: true }, id);
}
