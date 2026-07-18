import { z } from "zod";

import { IdSchema, IsoDateTimeSchema, OptimisticVersionSchema, TimeZoneSchema } from "./common";

export const ScheduleKindSchema = z.enum(["hourly_research", "five_hour_polish"]);

export const ScheduleSchema = z
  .object({
    id: IdSchema,
    projectId: IdSchema,
    kind: ScheduleKindSchema,
    enabled: z.boolean(),
    intervalMinutes: z.union([z.literal(60), z.literal(300)]),
    timeZone: TimeZoneSchema,
    nextRunAt: IsoDateTimeSchema.nullable(),
    lastEnqueuedAt: IsoDateTimeSchema.nullable(),
    consecutiveFailures: z.number().int().nonnegative(),
    optimisticVersion: OptimisticVersionSchema,
  })
  .strict();

export const SchedulePatchInputSchema = z
  .object({
    enabled: z.boolean(),
    optimisticVersion: OptimisticVersionSchema,
  })
  .strict();

export type Schedule = z.infer<typeof ScheduleSchema>;

