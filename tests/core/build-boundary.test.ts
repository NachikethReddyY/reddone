import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import { assertEditableArtifactPath, buildArtifactManifest, verifyArtifactManifest } from "@/policy/build-boundary";
import { hashVerificationReport, verifySignedVerificationReport, verifyVerificationSignature } from "@/server/security/verification-signature";

describe("generated application boundary", () => {
  it("accepts only generated roots and rejects traversal or protected files", () => {
    expect(assertEditableArtifactPath("src/app/generated/page.tsx")).toBe("src/app/generated/page.tsx");
    expect(() => assertEditableArtifactPath("../package.json")).toThrow(/traversal/i);
    expect(() => assertEditableArtifactPath("package.json")).toThrow(/protected|allowlist/i);
    expect(() => assertEditableArtifactPath("src/app/generated/payload.sh")).toThrow(/unsupported/i);
  });

  it("detects any artifact mutation during reconstruction", () => {
    const original = [{ path: "src/app/generated/page.tsx", content: Buffer.from("export default function Page() { return null }") }];
    const manifest = buildArtifactManifest(original);
    expect(verifyArtifactManifest(manifest, original).artifactSha256).toBe(manifest.artifactSha256);
    expect(() => verifyArtifactManifest(manifest, [{ ...original[0]!, content: Buffer.from("mutated") }])).toThrow(/mismatch/i);
  });

  it("verifies signed reports in constant-format HMAC form", () => {
    const key = "v".repeat(48);
    const reportHash = "a".repeat(64);
    const signature = createHmac("sha256", key).update(reportHash).digest("base64url");
    expect(verifyVerificationSignature({ reportHash, signature, key })).toBe(true);
    expect(verifyVerificationSignature({ reportHash: "b".repeat(64), signature, key })).toBe(false);
    expect(verifyVerificationSignature({ reportHash, signature, key: undefined })).toBe(false);
  });

  it("rejects a correctly signed hash when the report body was changed", () => {
    const key = "v".repeat(48);
    const report = { schemaVersion: "1", artifactHash: "a".repeat(64), gates: [{ name: "typecheck", status: "passed" }] };
    const reportHash = hashVerificationReport(report);
    const signature = createHmac("sha256", key).update(reportHash).digest("base64url");
    expect(verifySignedVerificationReport({ report, reportHash, signature, key })).toBe(true);
    expect(verifySignedVerificationReport({
      report: { ...report, artifactHash: "b".repeat(64) },
      reportHash,
      signature,
      key,
    })).toBe(false);
    expect(verifySignedVerificationReport({
      report: { gates: report.gates, artifactHash: report.artifactHash, schemaVersion: report.schemaVersion },
      reportHash,
      signature,
      key,
    })).toBe(true);
  });
});
