import { z } from "zod";

import { IdSchema, IsoDateTimeSchema, MoneyMicrosSchema, Sha256Schema, UrlSchema } from "./common";
import { WorkflowModelSchema } from "./model";

const HTML_TAG = /<\/?[A-Za-z][^>]*>/;
const REMOTE_FETCH_INSTRUCTION =
  /\b(?:curl|wget)\s+(?:-[A-Za-z]+\s+)*https?:\/\/|\bfetch\s*\(\s*["']https?:\/\/|\b(?:open|request|get|download|retrieve)\s+(?:the\s+)?(?:url\s+)?https?:\/\//i;

export const AuthorizedImportTextSchema = z
  .string()
  .trim()
  .min(1)
  .max(20_000)
  .refine((value) => !HTML_TAG.test(value) && !REMOTE_FETCH_INSTRUCTION.test(value), {
    message: "Imported documents cannot contain HTML or remote-fetch instructions",
  });

export const ResearchDocumentInputSchema = z
  .object({
    externalId: z.string().trim().min(1).max(300),
    title: AuthorizedImportTextSchema.pipe(z.string().max(500)),
    body: AuthorizedImportTextSchema,
    permalink: UrlSchema.optional(),
    attribution: z.string().trim().min(1).max(300),
    publishedAt: IsoDateTimeSchema.optional(),
    score: z.number().int().optional(),
    metadata: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).default({}),
  })
  .strict();

export const ResearchPacketSchema = z
  .object({
    schemaVersion: z.literal("1"),
    sourceLabel: z.string().trim().min(1).max(120),
    authorizationReference: z.string().trim().min(1).max(500),
    exportedAt: IsoDateTimeSchema,
    documents: z.array(ResearchDocumentInputSchema).min(1).max(1_000),
  })
  .strict();

export const EvidenceExcerptSchema = z
  .object({
    id: IdSchema,
    sourceExternalId: z.string().max(300),
    excerpt: z.string().trim().min(1).max(1_500),
    permalink: UrlSchema.nullable(),
    attribution: z.string().max(300),
    capturedAt: IsoDateTimeSchema,
    contentHash: Sha256Schema,
  })
  .strict();

export const FindingCandidateSchema = z
  .object({
    id: IdSchema,
    projectId: IdSchema,
    title: z.string().trim().min(2).max(200),
    problemSummary: z.string().trim().min(10).max(2_000),
    solutionConcept: z.string().trim().min(20).max(1_500).nullable(),
    audience: z.string().trim().min(2).max(500),
    frequencyScore: z.number().min(0).max(100),
    severityScore: z.number().min(0).max(100),
    willingnessToPayScore: z.number().min(0).max(100),
    feasibilityScore: z.number().min(0).max(100),
    totalScore: z.number().min(0).max(100),
    scoreExplanation: z.string().trim().min(1).max(2_000),
    selected: z.boolean(),
    evidence: z.array(EvidenceExcerptSchema).min(1).max(25),
    model: z.string().min(1).max(120),
    promptVersion: z.string().min(1).max(100),
    schemaVersion: z.string().min(1).max(100),
    createdAt: IsoDateTimeSchema,
  })
  .strict();

export const ResearchImportReceiptSchema = z
  .object({
    importId: IdSchema,
    projectId: IdSchema,
    contentHash: Sha256Schema,
    documentCount: z.number().int().positive().max(1_000),
    byteSize: z.number().int().positive().max(10_000_000),
    acceptedAt: IsoDateTimeSchema,
  })
  .strict();

export const SelectFindingInputSchema = z.object({}).strict();

export const GenerateFindingSpecInputSchema = z
  .object({
    budgetCeilingMicros: MoneyMicrosSchema.refine((value) => value > 0, {
      message: "Specification generation requires a positive budget ceiling",
    }),
    model: WorkflowModelSchema.optional(),
  })
  .strict();

export type ResearchDocumentInput = z.infer<typeof ResearchDocumentInputSchema>;
export type ResearchPacket = z.infer<typeof ResearchPacketSchema>;
export type EvidenceExcerpt = z.infer<typeof EvidenceExcerptSchema>;
export type FindingCandidate = z.infer<typeof FindingCandidateSchema>;
export type SelectFindingInput = z.infer<typeof SelectFindingInputSchema>;
export type GenerateFindingSpecInput = z.infer<typeof GenerateFindingSpecInputSchema>;
