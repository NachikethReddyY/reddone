import { describe, expect, it } from "vitest";

import type { ApprovalPayload } from "@/contracts";
import {
  canonicalJson,
  canonicalizeApprovalPayload,
  createCanonicalApprovalRecord,
  hashApprovalPayload,
  verifyApprovalPayloadHash,
} from "@/server/security";

const payload: ApprovalPayload = {
  kind: "specification_build",
  workspaceId: "workspace-1",
  projectId: "project-1",
  projectOptimisticVersion: 3,
  providerAccounts: [
    { provider: "kimi", accountId: "kimi-account" },
    { provider: "daytona", accountId: "daytona-account" },
  ],
  costCeilingMicros: 5_000_000,
  expiresAt: "2026-07-12T00:00:00.000Z",
  specVersionId: "spec-1",
  specVersion: 2,
  specOptimisticVersion: 4,
  specHash: "a".repeat(64),
};

describe("canonical approvals", () => {
  it("is independent of object insertion order", () => {
    const canonical = canonicalizeApprovalPayload(payload);
    const reordered = {
      specHash: "a".repeat(64),
      specOptimisticVersion: 4,
      specVersion: 2,
      specVersionId: "spec-1",
      expiresAt: "2026-07-12T00:00:00.000Z",
      costCeilingMicros: 5_000_000,
      providerAccounts: payload.providerAccounts,
      projectOptimisticVersion: 3,
      projectId: "project-1",
      workspaceId: "workspace-1",
      kind: "specification_build" as const,
    };
    expect(canonicalizeApprovalPayload(reordered)).toBe(canonical);
    expect(hashApprovalPayload(reordered)).toBe(hashApprovalPayload(payload));
    expect(hashApprovalPayload({ ...payload, providerAccounts: [...payload.providerAccounts].reverse() })).toBe(
      hashApprovalPayload(payload),
    );
  });

  it("changes the hash when a time-of-check field changes", () => {
    const changed: ApprovalPayload = { ...payload, costCeilingMicros: payload.costCeilingMicros + 1 };
    expect(hashApprovalPayload(changed)).not.toBe(hashApprovalPayload(payload));
  });

  it("binds the exact verified source tree into a release decision", () => {
    const release: ApprovalPayload = {
      kind: "first_release",
      workspaceId: "workspace-1",
      projectId: "project-1",
      projectOptimisticVersion: 8,
      providerAccounts: [
        { provider: "github", accountId: "installation-1" },
        { provider: "vercel", accountId: "team_example" },
      ],
      costCeilingMicros: 1_000_000,
      expiresAt: "2026-07-12T00:00:00.000Z",
      specVersionId: "spec-1",
      specVersion: 2,
      specOptimisticVersion: 4,
      specHash: "a".repeat(64),
      artifactId: "output-1",
      artifactHash: "b".repeat(64),
      sourceArtifactId: "source-1",
      sourceArtifactHash: "c".repeat(64),
      verificationReportId: "report-1",
      verificationReportHash: "d".repeat(64),
      repository: {
        owner: "acme",
        name: "latepay-copilot",
        visibility: "private",
        installationId: "installation-1",
        externalRepositoryId: null,
        ownershipMarker: `reddone-v1-github-${"1".repeat(24)}`,
        optimisticVersion: 0,
      },
      deployment: {
        provider: "vercel",
        teamId: "team_example",
        projectId: "latepay-copilot",
        externalProjectId: null,
        ownershipMarker: `reddone-v1-vercel-${"2".repeat(24)}`,
        environment: "production",
        optimisticVersion: 0,
      },
      secretGrants: [],
    };
    const hash = hashApprovalPayload(release);
    expect(verifyApprovalPayloadHash(release, hash)).toBe(true);
    const changedSource: ApprovalPayload = { ...release, sourceArtifactHash: "e".repeat(64) };
    expect(verifyApprovalPayloadHash(changedSource, hash)).toBe(false);
  });

  it("creates a self-consistent persistence record", () => {
    const record = createCanonicalApprovalRecord(payload);
    expect(record.payloadHash).toHaveLength(64);
    expect(verifyApprovalPayloadHash(payload, record.payloadHash)).toBe(true);
    expect(verifyApprovalPayloadHash({ ...payload, projectOptimisticVersion: 4 }, record.payloadHash)).toBe(false);
    expect(record.payloadCanonical).toBe(canonicalizeApprovalPayload(payload));
  });

  it("rejects ambiguous JSON values", () => {
    expect(() => canonicalJson({ a: undefined })).toThrow(/undefined/i);
    expect(() => canonicalJson({ value: Number.NaN })).toThrow(/finite/i);
    expect(() => canonicalJson(new Date())).toThrow(/Date/i);
  });
});
