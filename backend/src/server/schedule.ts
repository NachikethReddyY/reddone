export type FixedScheduleKind = "hourly_research" | "five_hour_polish";

const INTERVALS: Readonly<Record<FixedScheduleKind, number>> = {
  hourly_research: 60 * 60_000,
  five_hour_polish: 5 * 60 * 60_000,
};

export interface DueSchedule {
  kind: FixedScheduleKind;
  enabled: boolean;
  nextRunAt: Date | null;
  consecutiveFailures: number;
  backoffUntil: Date | null;
}

export interface ScheduleDecision {
  enqueue: boolean;
  scheduledFor: Date | null;
  nextRunAt: Date | null;
}

export function scheduleIntervalMs(kind: FixedScheduleKind): number {
  return INTERVALS[kind];
}

export function nextScheduledAt(kind: FixedScheduleKind, after: Date): Date {
  return new Date(after.getTime() + scheduleIntervalMs(kind));
}

/** Coalesces any number of missed intervals into one enqueue and one future due time. */
export function decideDueSchedule(schedule: DueSchedule, now = new Date()): ScheduleDecision {
  if (!schedule.enabled || !schedule.nextRunAt) {
    return { enqueue: false, scheduledFor: null, nextRunAt: schedule.nextRunAt };
  }
  if (schedule.backoffUntil && schedule.backoffUntil.getTime() > now.getTime()) {
    return { enqueue: false, scheduledFor: null, nextRunAt: schedule.backoffUntil };
  }
  if (schedule.nextRunAt.getTime() > now.getTime()) {
    return { enqueue: false, scheduledFor: null, nextRunAt: schedule.nextRunAt };
  }
  return {
    enqueue: true,
    scheduledFor: schedule.nextRunAt,
    nextRunAt: nextScheduledAt(schedule.kind, now),
  };
}

export function failureBackoffUntil(kind: FixedScheduleKind, consecutiveFailures: number, now = new Date()): Date {
  const exponent = Math.max(0, Math.min(consecutiveFailures - 1, 6));
  const backoff = Math.min(5 * 60_000 * 2 ** exponent, scheduleIntervalMs(kind));
  return new Date(now.getTime() + backoff);
}
