import { z } from "zod";

import {
  IdSchema,
  IsoDateTimeSchema,
  OptimisticVersionSchema,
  TimeZoneSchema,
} from "./common";

export const ResearchModeSchema = z.enum(["fixture", "authorized_import", "live_reddit"]);
export const ProjectStatusSchema = z.enum([
  "draft",
  "researching",
  "awaiting_spec_approval",
  "ready_to_build",
  "building",
  "awaiting_release_approval",
  "released",
  "paused",
  "failed",
  "archived",
]);

export const ProjectConfigSchema = z
  .object({
    marketLabel: z.string().trim().min(2).max(120),
    researchContext: z.string().trim().min(1).max(5_000),
    researchMode: ResearchModeSchema,
    sourceLabels: z.array(z.string().trim().min(1).max(120)).max(25).default([]),
    maxDocumentsPerRun: z.number().int().min(1).max(1_000).default(100),
    maxCostMicrosPerRun: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(5_000_000),
    workspaceTimeZone: TimeZoneSchema,
    hourlyResearchEnabled: z.boolean().default(false),
    fiveHourPolishEnabled: z.boolean().default(false),
  })
  .strict()
  .superRefine((config, context) => {
    if (config.researchMode === "live_reddit" && config.sourceLabels.length === 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["sourceLabels"],
        message: "Live Reddit research requires at least one approved source label",
      });
    }
  });

export const ProjectCreateInputSchema = z
  .object({
    name: z.string().trim().min(2).max(120),
    slug: z.string().trim().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(80),
    config: ProjectConfigSchema,
  })
  .strict();

export const ProjectPatchInputSchema = z
  .object({
    name: z.string().trim().min(2).max(120).optional(),
    config: ProjectConfigSchema.optional(),
    status: z.enum(["paused", "archived"]).optional(),
    optimisticVersion: OptimisticVersionSchema,
  })
  .strict();

export const ProjectWorkspaceContextSchema = z
  .object({
    workspaceTimeZone: TimeZoneSchema,
    demoMode: z.boolean(),
  })
  .strict();

export const ProjectDraftRunEstimateInputSchema = z
  .object({
    kind: z.literal("research").default("research"),
    name: z.string().trim().min(2).max(120),
    marketLabel: z.string().trim().min(2).max(120),
    researchContext: z.string().trim().min(1).max(5_000),
    maxDocumentsPerRun: z.number().int().min(1).max(1_000),
    maxCostMicrosPerRun: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    model: z.string().trim().min(1).max(120).optional(),
  })
  .strict();

export const ProjectSummarySchema = z
  .object({
    id: IdSchema,
    name: z.string(),
    slug: z.string(),
    status: ProjectStatusSchema,
    marketLabel: z.string(),
    currentBlocker: z.string().max(500).nullable(),
    latestEvidenceSummary: z.string().max(1_000).nullable(),
    latestRunId: IdSchema.nullable(),
    latestRunStatus: z.string().nullable(),
    liveUrl: z.string().url().nullable(),
    nextAction: z.string().max(500),
    nextScheduledAt: IsoDateTimeSchema.nullable(),
    optimisticVersion: OptimisticVersionSchema,
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
  })
  .strict();

export const ProjectDetailSchema = ProjectSummarySchema.extend({
  config: ProjectConfigSchema,
  selectedFindingId: IdSchema.nullable(),
  currentSpecVersionId: IdSchema.nullable(),
}).strict();

export type ResearchMode = z.infer<typeof ResearchModeSchema>;
export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;
export type ProjectCreateInput = z.infer<typeof ProjectCreateInputSchema>;
export type ProjectPatchInput = z.infer<typeof ProjectPatchInputSchema>;
export type ProjectWorkspaceContext = z.infer<typeof ProjectWorkspaceContextSchema>;
export type ProjectDraftRunEstimateInput = z.infer<typeof ProjectDraftRunEstimateInputSchema>;
export type ProjectSummary = z.infer<typeof ProjectSummarySchema>;
export type ProjectDetail = z.infer<typeof ProjectDetailSchema>;
