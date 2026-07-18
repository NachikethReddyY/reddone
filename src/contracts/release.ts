import { z } from "zod";

import {
  IdSchema,
  IsoDateTimeSchema,
  SecretVersionRefSchema,
  Sha256Schema,
  UrlSchema,
} from "./common";

export const BuildManifestEntrySchema = z
  .object({
    path: z
      .string()
      .trim()
      .min(1)
      .max(500)
      .refine((path) => !path.startsWith("/") && !path.split("/").includes(".."), {
        message: "Manifest paths must be relative and cannot traverse directories",
      }),
    sha256: Sha256Schema,
    byteSize: z.number().int().nonnegative().max(5_000_000),
    mediaType: z.string().trim().min(1).max(200),
  })
  .strict();

export const BuildManifestSchema = z
  .object({
    schemaVersion: z.literal("1"),
    artifactHash: Sha256Schema,
    entries: z.array(BuildManifestEntrySchema).max(5_000),
    fileCount: z.number().int().nonnegative().max(5_000),
    totalBytes: z.number().int().nonnegative().max(100_000_000),
    generatedAt: IsoDateTimeSchema,
  })
  .strict()
  .refine((manifest) => manifest.fileCount === manifest.entries.length, {
    path: ["fileCount"],
    message: "fileCount must equal the number of manifest entries",
  })
  .refine(
    (manifest) => manifest.totalBytes === manifest.entries.reduce((total, entry) => total + entry.byteSize, 0),
    { path: ["totalBytes"], message: "totalBytes must equal the manifest entry byte total" },
  );

export const VerificationGateSchema = z
  .object({
    name: z.enum([
      "manifest",
      "secret_scan",
      "dependency_audit",
      "license_audit",
      "sast",
      "typecheck",
      "lint",
      "unit_tests",
      "playwright",
      "production_build",
    ]),
    status: z.enum(["passed", "failed", "skipped"]),
    durationMs: z.number().int().nonnegative(),
    summary: z.string().max(2_000),
  })
  .strict();

export const VerificationReportSchema = z
  .object({
    id: IdSchema,
    artifactId: IdSchema,
    artifactHash: Sha256Schema,
    verifierImage: z.string().min(1).max(500),
    status: z.enum(["pending", "passed", "failed", "expired"]),
    gates: z.array(VerificationGateSchema).max(25),
    reportHash: Sha256Schema,
    signature: z.string().min(16).max(4_096),
    verifiedAt: IsoDateTimeSchema.nullable(),
  })
  .strict();

export const DeploymentRecordSchema = z
  .object({
    id: IdSchema,
    projectId: IdSchema,
    artifactId: IdSchema,
    provider: z.literal("vercel"),
    externalProjectId: z.string().max(300),
    externalDeploymentId: z.string().max(300),
    teamId: z.string().max(300),
    environment: z.enum(["preview", "production"]),
    status: z.enum([
      "queued",
      "uploading",
      "ready_unpromoted",
      "health_checking",
      "healthy",
      "failed",
      "rolled_back",
      "canceled",
    ]),
    url: UrlSchema.nullable(),
    artifactHash: Sha256Schema,
    secretGrants: z.array(SecretVersionRefSchema),
    lastKnownGood: z.boolean(),
    promotedAt: IsoDateTimeSchema.nullable(),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
  })
  .strict();

export type BuildManifest = z.infer<typeof BuildManifestSchema>;
export type VerificationReport = z.infer<typeof VerificationReportSchema>;
export type DeploymentRecord = z.infer<typeof DeploymentRecordSchema>;

