import { z } from "zod";

import { IdSchema, IsoDateTimeSchema, OptimisticVersionSchema, Sha256Schema } from "./common";

export const ProductSpecSchema = z
  .object({
    productName: z.string().trim().min(2).max(120),
    oneLinePitch: z.string().trim().min(10).max(300),
    problem: z.string().trim().min(20).max(5_000),
    targetAudience: z.string().trim().min(5).max(2_000),
    proposedSolution: z.string().trim().min(20).max(8_000),
    inScope: z.array(z.string().trim().min(2).max(500)).min(1).max(30),
    outOfScope: z.array(z.string().trim().min(2).max(500)).max(30),
    userStories: z
      .array(
        z
          .object({
            actor: z.string().trim().min(1).max(100),
            need: z.string().trim().min(2).max(500),
            outcome: z.string().trim().min(2).max(500),
          })
          .strict(),
      )
      .min(1)
      .max(30),
    acceptanceCriteria: z.array(z.string().trim().min(2).max(500)).min(1).max(50),
    constraints: z.array(z.string().trim().min(2).max(500)).max(30),
    risks: z.array(z.string().trim().min(2).max(500)).max(30),
    evidenceIds: z.array(IdSchema).min(1).max(100),
  })
  .strict();

export const ProductSpecVersionSchema = z
  .object({
    id: IdSchema,
    projectId: IdSchema,
    version: z.number().int().positive(),
    optimisticVersion: OptimisticVersionSchema,
    status: z.enum(["draft", "pending_approval", "approved", "superseded", "rejected"]),
    spec: ProductSpecSchema,
    contentHash: Sha256Schema,
    basedOnFindingId: IdSchema,
    model: z.string().min(1).max(120).nullable(),
    promptVersion: z.string().min(1).max(100).nullable(),
    schemaVersion: z.string().min(1).max(100),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
  })
  .strict();

export const ProductSpecPatchInputSchema = z
  .object({
    spec: ProductSpecSchema,
    optimisticVersion: OptimisticVersionSchema,
  })
  .strict();

export type ProductSpec = z.infer<typeof ProductSpecSchema>;
export type ProductSpecVersion = z.infer<typeof ProductSpecVersionSchema>;

