import { z } from "zod";

import { IdSchema, IsoDateTimeSchema, JsonValueSchema, UrlSchema } from "./common";

export const DecimalStringSchema = z.string().regex(/^(?:0|[1-9]\d*)$/, "Expected a non-negative decimal string");
export const UsageGranularitySchema = z.enum(["day", "week"]);
export const UsageRunKindSchema = z.enum(["research", "build", "polish", "release", "rollback"]);

const usageQueryFields = {
  from: IsoDateTimeSchema.optional(),
  to: IsoDateTimeSchema.optional(),
  granularity: UsageGranularitySchema.default("day"),
  projectId: IdSchema.optional(),
  runKind: UsageRunKindSchema.optional(),
  operation: z.string().trim().min(1).max(150).optional(),
  model: z.string().trim().min(1).max(120).optional(),
};

function validateUsageRange(query: { from?: string | undefined; to?: string | undefined }, context: z.RefinementCtx) {
  if (!query.from || !query.to) return;
  const from = new Date(query.from).getTime();
  const to = new Date(query.to).getTime();
  if (from >= to) {
    context.addIssue({ code: "custom", path: ["to"], message: "to must be later than from" });
  }
  if (to - from > 366 * 24 * 60 * 60 * 1_000) {
    context.addIssue({ code: "custom", path: ["to"], message: "Usage ranges cannot exceed one year" });
  }
}

export const UsageQuerySchema = z.object(usageQueryFields).strict().superRefine(validateUsageRange);

export const ResolvedUsageQuerySchema = z.object({
  ...usageQueryFields,
  from: IsoDateTimeSchema,
  to: IsoDateTimeSchema,
}).strict().superRefine(validateUsageRange);

export const UsageTotalsSchema = z
  .object({
    providerCalls: z.number().int().nonnegative(),
    inputTokens: DecimalStringSchema,
    outputTokens: DecimalStringSchema,
    totalTokens: DecimalStringSchema,
    costMicros: DecimalStringSchema,
    completedRuns: z.number().int().nonnegative(),
    averageCostPerCompletedRunMicros: DecimalStringSchema,
  })
  .strict();

export const UsageTimeBucketSchema = z
  .object({
    start: IsoDateTimeSchema,
    end: IsoDateTimeSchema,
    providerCalls: z.number().int().nonnegative(),
    inputTokens: DecimalStringSchema,
    outputTokens: DecimalStringSchema,
    totalTokens: DecimalStringSchema,
    costMicros: DecimalStringSchema,
  })
  .strict();

export const UsageBreakdownSchema = z
  .object({
    dimension: z.enum(["model", "operation"]),
    value: z.string().trim().min(1).max(150),
    providerCalls: z.number().int().nonnegative(),
    inputTokens: DecimalStringSchema,
    outputTokens: DecimalStringSchema,
    totalTokens: DecimalStringSchema,
    costMicros: DecimalStringSchema,
  })
  .strict();

export const RecentRunUsageSummarySchema = z
  .object({
    runId: IdSchema,
    projectId: IdSchema,
    projectName: z.string().trim().min(1).max(120),
    kind: UsageRunKindSchema,
    status: z.enum(["queued", "running", "waiting_for_approval", "cancel_requested", "canceled", "succeeded", "failed"]),
    models: z.array(z.string().trim().min(1).max(120)).max(20),
    providerCalls: z.number().int().nonnegative(),
    inputTokens: DecimalStringSchema,
    outputTokens: DecimalStringSchema,
    totalTokens: DecimalStringSchema,
    costMicros: DecimalStringSchema,
    startedAt: IsoDateTimeSchema.nullable(),
    finishedAt: IsoDateTimeSchema.nullable(),
  })
  .strict();

export const UsageReportSchema = z
  .object({
    source: z.enum(["actual", "simulated"]),
    simulated: z.boolean(),
    query: ResolvedUsageQuerySchema,
    totals: UsageTotalsSchema,
    buckets: z.array(UsageTimeBucketSchema).max(400),
    breakdowns: z.array(UsageBreakdownSchema).max(1_000),
    recentRuns: z.array(RecentRunUsageSummarySchema).max(50),
    generatedAt: IsoDateTimeSchema,
  })
  .strict()
  .superRefine((report, context) => {
    if (report.simulated !== (report.source === "simulated")) {
      context.addIssue({ code: "custom", path: ["simulated"], message: "simulated must match the report source" });
    }
  });

export const RunUsageEntrySchema = z
  .object({
    id: IdSchema,
    provider: z.enum(["kimi", "daytona", "reddit", "github", "vercel"]),
    externalUsageId: z.string().max(300).nullable(),
    model: z.string().trim().min(1).max(120),
    operation: z.string().trim().min(1).max(150),
    inputTokens: DecimalStringSchema,
    outputTokens: DecimalStringSchema,
    costMicros: DecimalStringSchema,
    inputRateMicrosPerMillion: DecimalStringSchema.nullable(),
    outputRateMicrosPerMillion: DecimalStringSchema.nullable(),
    pricingVersion: z.string().trim().min(1).max(100).nullable(),
    pricingSnapshotAvailable: z.boolean(),
    occurredAt: IsoDateTimeSchema,
  })
  .strict();

export const RunUsageAggregateSchema = UsageTotalsSchema.pick({
  providerCalls: true,
  inputTokens: true,
  outputTokens: true,
  totalTokens: true,
  costMicros: true,
}).extend({
  models: z.array(z.string().trim().min(1).max(120)).max(20),
  pricingSnapshotsComplete: z.boolean(),
  inputUnits: z.number().int().nonnegative().optional(),
  outputUnits: z.number().int().nonnegative().optional(),
}).strict();

const EstimateTokensSchema = z
  .object({
    inputTokens: DecimalStringSchema,
    outputTokens: DecimalStringSchema,
    totalTokens: DecimalStringSchema,
  })
  .strict();

export const RunEstimateInputSchema = z
  .object({
    kind: z.enum(["research", "build", "polish"]),
    model: z.string().trim().min(1).max(120).optional(),
  })
  .strict();

export const RunEstimateResponseSchema = z
  .object({
    projectId: IdSchema,
    simulated: z.boolean(),
    runKind: z.enum(["research", "build", "polish"]),
    model: z.string().trim().min(1).max(120),
    method: z.enum(["project_history", "workspace_history", "cold_start"]),
    confidence: z.enum(["low", "medium", "high"]),
    sampleCount: z.number().int().nonnegative(),
    low: EstimateTokensSchema,
    expected: EstimateTokensSchema,
    high: EstimateTokensSchema,
    providerCostMicros: z
      .object({
        low: DecimalStringSchema,
        expected: DecimalStringSchema,
        high: DecimalStringSchema,
        pricingVersion: z.string().trim().min(1).max(100).nullable(),
        ratesConfigured: z.boolean(),
      })
      .strict(),
    creditQuote: z
      .object({
        operation: z.enum(["research", "build", "polish"]),
        credits: DecimalStringSchema,
        pricingVersion: z.string().trim().min(1).max(100),
      })
      .strict(),
    authorizedProviderCostCeilingMicros: DecimalStringSchema,
    assumptions: z.array(z.string().trim().min(1).max(500)).min(1).max(20),
    scenarioOnly: z.literal(true),
    estimatedAt: IsoDateTimeSchema,
  })
  .strict();

export const RunArtifactVerificationSchema = z
  .object({
    id: IdSchema,
    status: z.string().trim().min(1).max(50),
    verifierImage: z.string().trim().min(1).max(500),
    report: JsonValueSchema,
    reportHash: z.string().trim().min(1).max(128),
    signatureKeyId: z.string().trim().min(1).max(500),
    verifiedAt: IsoDateTimeSchema.nullable(),
    expiresAt: IsoDateTimeSchema.nullable(),
  })
  .strict();

export const RunArtifactSchema = z
  .object({
    id: IdSchema,
    kind: z.string().trim().min(1).max(100),
    artifactHash: z.string().trim().min(1).max(128),
    manifestHash: z.string().trim().min(1).max(128),
    byteSize: z.number().int().nonnegative(),
    fileCount: z.number().int().nonnegative(),
    expiresAt: IsoDateTimeSchema.nullable(),
    createdAt: IsoDateTimeSchema,
    verification: RunArtifactVerificationSchema.nullable(),
  })
  .strict();

export const DemoRunBudgetSchema = z
  .object({
    reservedCents: z.number().int().nonnegative(),
    spentCents: z.number().int().nonnegative(),
    modelTurns: z.number().int().nonnegative(),
    maxModelTurns: z.number().int().positive(),
  })
  .strict();

export const NullablePreviewUrlSchema = UrlSchema.nullable();

export type UsageQuery = z.infer<typeof UsageQuerySchema>;
export type ResolvedUsageQuery = z.infer<typeof ResolvedUsageQuerySchema>;
export type UsageReport = z.infer<typeof UsageReportSchema>;
export type RunUsageEntry = z.infer<typeof RunUsageEntrySchema>;
export type RunUsageAggregate = z.infer<typeof RunUsageAggregateSchema>;
export type RunEstimateInput = z.infer<typeof RunEstimateInputSchema>;
export type RunEstimateResponse = z.infer<typeof RunEstimateResponseSchema>;
