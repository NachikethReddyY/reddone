import { z } from "zod";

import {
  IdSchema,
  IsoDateTimeSchema,
  JsonValueSchema,
  MoneyMicrosSchema,
  OptimisticVersionSchema,
} from "./common";
import {
  DemoRunBudgetSchema,
  NullablePreviewUrlSchema,
  RunArtifactSchema,
  RunUsageAggregateSchema,
  RunUsageEntrySchema,
} from "./usage";

export const RunKindSchema = z.enum(["research", "build", "polish", "release", "rollback"]);
export const RunStatusSchema = z.enum([
  "queued",
  "running",
  "waiting_for_approval",
  "cancel_requested",
  "canceled",
  "succeeded",
  "failed",
]);
export const WorkflowStepStatusSchema = z.enum([
  "pending",
  "running",
  "waiting",
  "succeeded",
  "failed",
  "canceled",
  "skipped",
]);

export const WorkflowStepSchema = z
  .object({
    id: IdSchema,
    key: z.string().trim().min(1).max(100),
    label: z.string().trim().min(1).max(200),
    status: WorkflowStepStatusSchema,
    attempt: z.number().int().positive(),
    startedAt: IsoDateTimeSchema.nullable(),
    finishedAt: IsoDateTimeSchema.nullable(),
    summary: z.string().max(2_000).nullable(),
  })
  .strict();

export const RunStateSchema = z
  .object({
    id: IdSchema,
    projectId: IdSchema,
    kind: RunKindSchema,
    status: RunStatusSchema,
    stateVersion: OptimisticVersionSchema,
    attempt: z.number().int().positive(),
    currentStepKey: z.string().max(100).nullable(),
    steps: z.array(WorkflowStepSchema).max(100),
    budgetCeilingMicros: MoneyMicrosSchema,
    reservedMicros: MoneyMicrosSchema,
    actualCostMicros: MoneyMicrosSchema,
    cancelRequestedAt: IsoDateTimeSchema.nullable(),
    startedAt: IsoDateTimeSchema.nullable(),
    finishedAt: IsoDateTimeSchema.nullable(),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
  })
  .strict();

const RunDetailUsageFields = {
  usage: RunUsageAggregateSchema,
  usageEntries: z.array(RunUsageEntrySchema).max(10_000),
};

export const LiveRunDetailSchema = RunStateSchema.extend({
  failureCode: z.string().max(100).nullable(),
  failureMessage: z.string().max(1_000).nullable(),
  mode: z.literal("live"),
  artifactHash: z.string().max(128).nullable(),
  previewUrl: NullablePreviewUrlSchema,
  ...RunDetailUsageFields,
  artifacts: z.array(RunArtifactSchema).max(1_000),
}).strict();

export const DemoRunDetailSchema = RunStateSchema.extend({
  mode: z.enum(["demo", "import"]),
  currentStep: z.string().trim().min(1).max(500),
  progress: z.number().int().min(0).max(100),
  artifactHash: z.string().max(128).nullable(),
  previewUrl: NullablePreviewUrlSchema,
  budget: DemoRunBudgetSchema,
  ...RunDetailUsageFields,
}).strict();

export const RunDetailSchema = z.union([LiveRunDetailSchema, DemoRunDetailSchema]);

export const CreateRunInputSchema = z
  .object({
    kind: z.enum(["research", "build", "polish"]),
    specVersionId: IdSchema.optional(),
    budgetCeilingMicros: MoneyMicrosSchema,
  })
  .strict()
  .superRefine((input, context) => {
    if ((input.kind === "build" || input.kind === "polish") && !input.specVersionId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["specVersionId"],
        message: "Build and polish runs require an immutable specification version",
      });
    }
  });

export const ActivityEventSchema = z
  .object({
    id: IdSchema,
    runId: IdSchema.nullable(),
    projectId: IdSchema.nullable(),
    sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    type: z.string().trim().min(1).max(150),
    severity: z.enum(["debug", "info", "warning", "error", "success"]),
    message: z.string().max(4_000),
    data: JsonValueSchema,
    createdAt: IsoDateTimeSchema,
  })
  .strict();

export const RunEventPageSchema = z
  .object({
    items: z.array(ActivityEventSchema),
    nextCursor: z.string().nullable(),
    retentionStartsAt: IsoDateTimeSchema,
  })
  .strict();

export type RunKind = z.infer<typeof RunKindSchema>;
export type RunStatus = z.infer<typeof RunStatusSchema>;
export type RunState = z.infer<typeof RunStateSchema>;
export type RunDetail = z.infer<typeof RunDetailSchema>;
export type ActivityEvent = z.infer<typeof ActivityEventSchema>;
