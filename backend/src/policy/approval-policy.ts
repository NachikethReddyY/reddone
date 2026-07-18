import { createHash, timingSafeEqual } from "node:crypto";

export const approvalKinds = [
  "specification_build",
  "first_release",
  "polish_release",
  "secret_grant",
  "rollback",
] as const;

export type ApprovalKind = (typeof approvalKinds)[number];

export interface CanonicalApproval {
  id: string;
  kind: ApprovalKind;
  workspaceId: string;
  projectId: string;
  specHash: string;
  specVersionId?: string;
  specVersion?: number;
  specOptimisticVersion?: number;
  projectOptimisticVersion?: number;
  artifactId?: string;
  artifactHash?: string;
  verificationReportId?: string;
  verificationReportHash?: string;
  sourceArtifactId?: string;
  sourceArtifactHash?: string;
  providerAccounts: Record<string, string>;
  repositoryVisibility?: "private";
  deploymentTarget?: { teamId: string; projectId: string; environment: "production" | "preview" };
  repository?: {
    owner: string;
    name: string;
    visibility: "private";
    installationId: string;
    externalRepositoryId: string | null;
    ownershipMarker: string;
    optimisticVersion: number;
  };
  deployment?: {
    provider: "vercel";
    teamId: string;
    projectId: string;
    externalProjectId: string | null;
    ownershipMarker: string;
    environment: "production" | "preview";
    optimisticVersion: number;
  };
  secretGrants: Array<{ name: string; version: number }>;
  costCeilingCents: number;
  optimisticVersions: Record<string, number>;
  expiresAt: string;
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalize(item)}`)
    .join(",")}}`;
}

export function approvalPayloadHash(payload: CanonicalApproval) {
  return createHash("sha256").update(canonicalize(payload)).digest("hex");
}

export function approvalHashMatches(payload: CanonicalApproval, expected: string) {
  const actual = Buffer.from(approvalPayloadHash(payload));
  const provided = Buffer.from(expected);
  return actual.length === provided.length && timingSafeEqual(actual, provided);
}

export function assertApprovalUsable(input: {
  payload: CanonicalApproval;
  payloadHash: string;
  status: "pending" | "approved" | "rejected" | "expired" | "consumed";
  now?: Date;
}) {
  if (!approvalHashMatches(input.payload, input.payloadHash)) throw new Error("Approval payload integrity check failed.");
  if (input.status !== "approved") throw new Error("Approval has not been granted.");
  if (new Date(input.payload.expiresAt) <= (input.now ?? new Date())) throw new Error("Approval has expired.");
}
