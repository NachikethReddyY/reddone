import { z } from "zod";

import {
  IdSchema,
  IsoDateTimeSchema,
  MoneyMicrosSchema,
  OptimisticVersionSchema,
  SecretVersionRefSchema,
  Sha256Schema,
} from "./common";

const ProviderAccountSchema = z
  .object({
    provider: z.enum(["kimi", "daytona", "github", "vercel", "reddit"]),
    accountId: z.string().trim().min(1).max(300),
  })
  .strict();

const ApprovalBaseShape = {
  workspaceId: IdSchema,
  projectId: IdSchema,
  projectOptimisticVersion: OptimisticVersionSchema,
  providerAccounts: z.array(ProviderAccountSchema).max(10),
  costCeilingMicros: MoneyMicrosSchema,
  expiresAt: IsoDateTimeSchema,
} as const;

const SpecReferenceShape = {
  specVersionId: IdSchema,
  specVersion: z.number().int().positive(),
  specOptimisticVersion: OptimisticVersionSchema,
  specHash: Sha256Schema,
} as const;

const ArtifactReferenceShape = {
  artifactId: IdSchema,
  artifactHash: Sha256Schema,
  verificationReportId: IdSchema,
  verificationReportHash: Sha256Schema,
} as const;

const ReleaseTargetShape = {
  sourceArtifactId: IdSchema,
  sourceArtifactHash: Sha256Schema,
  repository: z
    .object({
      owner: z.string().trim().min(1).max(200),
      name: z.string().trim().min(1).max(200),
      visibility: z.literal("private"),
      installationId: z.string().trim().min(1).max(300),
      externalRepositoryId: z.string().trim().min(1).max(300).nullable(),
      ownershipMarker: z.string().regex(/^reddone-v1-github-[a-f0-9]{24}$/),
      optimisticVersion: OptimisticVersionSchema,
    })
    .strict(),
  deployment: z
    .object({
      provider: z.literal("vercel"),
      teamId: z.string().trim().min(1).max(300),
      projectId: z.string().trim().min(1).max(300),
      externalProjectId: z.string().trim().min(1).max(300).nullable(),
      ownershipMarker: z.string().regex(/^reddone-v1-vercel-[a-f0-9]{24}$/),
      environment: z.enum(["preview", "production"]),
      optimisticVersion: OptimisticVersionSchema,
    })
    .strict(),
  secretGrants: z.array(SecretVersionRefSchema).max(100),
} as const;

export const SpecificationBuildApprovalPayloadSchema = z
  .object({
    kind: z.literal("specification_build"),
    ...ApprovalBaseShape,
    ...SpecReferenceShape,
  })
  .strict();

export const FirstReleaseApprovalPayloadSchema = z
  .object({
    kind: z.literal("first_release"),
    ...ApprovalBaseShape,
    ...SpecReferenceShape,
    ...ArtifactReferenceShape,
    ...ReleaseTargetShape,
  })
  .strict();

export const PolishReleaseApprovalPayloadSchema = z
  .object({
    kind: z.literal("polish_release"),
    ...ApprovalBaseShape,
    ...SpecReferenceShape,
    ...ArtifactReferenceShape,
    ...ReleaseTargetShape,
    previousDeploymentId: IdSchema,
    previousArtifactHash: Sha256Schema,
  })
  .strict();

export const SecretGrantApprovalPayloadSchema = z
  .object({
    kind: z.literal("secret_grant"),
    ...ApprovalBaseShape,
    ...ArtifactReferenceShape,
    secretGrants: z.array(SecretVersionRefSchema).min(1).max(100),
  })
  .strict();

export const RollbackApprovalPayloadSchema = z
  .object({
    kind: z.literal("rollback"),
    ...ApprovalBaseShape,
    deploymentId: IdSchema,
    deploymentOptimisticVersion: OptimisticVersionSchema,
    targetDeploymentId: IdSchema,
    targetArtifactHash: Sha256Schema,
  })
  .strict();

export const ApprovalPayloadSchema = z.discriminatedUnion("kind", [
  SpecificationBuildApprovalPayloadSchema,
  FirstReleaseApprovalPayloadSchema,
  PolishReleaseApprovalPayloadSchema,
  SecretGrantApprovalPayloadSchema,
  RollbackApprovalPayloadSchema,
]);

export const ApprovalResolutionInputSchema = z
  .object({
    decision: z.enum(["approved", "rejected"]),
    reason: z.string().trim().min(1).max(2_000).optional(),
    optimisticVersion: OptimisticVersionSchema,
    payloadHash: Sha256Schema,
  })
  .strict()
  .superRefine((input, context) => {
    if (input.decision === "rejected" && !input.reason) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["reason"],
        message: "A rejection reason is required",
      });
    }
  });

export const ApprovalRecordSchema = z
  .object({
    id: IdSchema,
    payload: ApprovalPayloadSchema,
    payloadHash: Sha256Schema,
    status: z.enum(["pending", "approved", "rejected", "expired", "consumed", "superseded"]),
    optimisticVersion: OptimisticVersionSchema,
    decidedByUserId: IdSchema.nullable(),
    decisionReason: z.string().max(2_000).nullable(),
    decidedAt: IsoDateTimeSchema.nullable(),
    consumedAt: IsoDateTimeSchema.nullable(),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
  })
  .strict();

export type ApprovalPayload = z.infer<typeof ApprovalPayloadSchema>;
export type ApprovalResolutionInput = z.infer<typeof ApprovalResolutionInputSchema>;
export type ApprovalRecord = z.infer<typeof ApprovalRecordSchema>;
