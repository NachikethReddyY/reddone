import "server-only";

import { createHash } from "node:crypto";

import { Storage, type File } from "@google-cloud/storage";

import { IntegrationError } from "./errors";
import { getRuntimeConfig } from "@/server/env";
import { createGcpWorkloadIdentityClient } from "@/server/security/gcp-auth";
import { createGcpV4SignedArtifactUrl } from "@/server/security/gcp-storage-signing";

const MAX_SIGNED_URL_SECONDS = 900;

function gcpConfig() {
  const config = getRuntimeConfig();
  if (config.vault.kind !== "gcp-kms") {
    throw new IntegrationError("not_configured", "Google Cloud artifact storage is not configured.", false, 503);
  }
  return config.vault;
}

function storage() {
  const config = gcpConfig();
  const authClient = createGcpWorkloadIdentityClient(config);
  // @google-cloud/storage and google-auth-library can resolve separate minor
  // AuthClient declarations under pnpm. Both use the same runtime contract.
  return new Storage({ projectId: config.projectId, authClient: authClient as never });
}

function artifactsBucket() {
  const config = gcpConfig();
  return storage().bucket(config.artifactBucket);
}

function retentionMetadata(kind: string) {
  if (kind === "verified-preview-file" || kind === "verified-preview-index") return "preview-3d";
  if (kind === "research-import") return "research-30d";
  return "release";
}

function isPreconditionFailure(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === 412;
}

function boundedExpiry(expiresInSeconds = 300) {
  return Math.min(Math.max(expiresInSeconds, 30), MAX_SIGNED_URL_SECONDS);
}

function assertArtifactObjectKey(key: string) {
  if (!/^workspaces\/[a-f0-9]{24}\/[a-z0-9_-]{1,64}\/[a-f0-9]{2}\/[a-f0-9]{64}$/.test(key)) {
    throw new Error("Invalid artifact object key.");
  }
}

export function artifactObjectKey(input: { workspaceId: string; kind: string; sha256: string }) {
  if (!/^[a-f0-9]{64}$/.test(input.sha256)) throw new Error("Artifact key requires a SHA-256 digest.");
  if (!/^[a-z0-9_-]{1,64}$/i.test(input.kind)) throw new Error("Artifact kind is invalid.");
  const workspace = createHash("sha256").update(input.workspaceId).digest("hex").slice(0, 24);
  return `workspaces/${workspace}/${input.kind}/${input.sha256.slice(0, 2)}/${input.sha256}`;
}

async function assertStoredObject(file: File, expectedSha256: string, maximumBytes: number) {
  const [metadata] = await file.getMetadata();
  const byteSize = Number(metadata.size ?? Number.NaN);
  const hash = metadata.metadata?.sha256;
  if (!Number.isSafeInteger(byteSize) || byteSize < 0 || byteSize > maximumBytes) {
    throw new Error("Artifact download exceeds the byte limit.");
  }
  if (hash !== expectedSha256) throw new Error("Stored artifact metadata hash mismatch.");
  return byteSize;
}

export async function putImmutableArtifact(input: {
  workspaceId: string;
  kind: string;
  body: Uint8Array;
  contentType: string;
  expectedSha256?: string;
}) {
  const sha256 = createHash("sha256").update(input.body).digest("hex");
  if (input.expectedSha256 && input.expectedSha256 !== sha256) throw new Error("Artifact content hash mismatch before upload.");
  const key = artifactObjectKey({ workspaceId: input.workspaceId, kind: input.kind, sha256 });
  const file = artifactsBucket().file(key);
  try {
    await file.save(input.body, {
      resumable: false,
      preconditionOpts: { ifGenerationMatch: 0 },
      metadata: {
        contentType: input.contentType,
        metadata: {
          sha256,
          immutable: "true",
          reddoneRetention: retentionMetadata(input.kind),
        },
      },
    });
  } catch (error) {
    if (!isPreconditionFailure(error)) throw error;
    const existing = await getVerifiedArtifact(key, sha256);
    if (existing.byteLength !== input.body.byteLength) throw new Error("Existing immutable artifact size mismatch.");
  }
  return { key, sha256, byteSize: input.body.byteLength };
}

export async function getVerifiedArtifact(key: string, expectedSha256: string, maximumBytes = 100 * 1024 * 1024) {
  assertArtifactObjectKey(key);
  if (!/^[a-f0-9]{64}$/.test(expectedSha256)) throw new Error("Invalid artifact download target.");
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > 100 * 1024 * 1024) throw new Error("Invalid artifact download size limit.");
  const file = artifactsBucket().file(key);
  await assertStoredObject(file, expectedSha256, maximumBytes);
  const [bytes] = await file.download();
  if (bytes.byteLength > maximumBytes) throw new Error("Artifact download exceeds the byte limit.");
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== expectedSha256) throw new Error("Downloaded artifact hash mismatch.");
  return bytes;
}

export async function deleteArtifactObject(key: string) {
  assertArtifactObjectKey(key);
  await artifactsBucket().file(key).delete({ ignoreNotFound: true });
}

/** Sandboxes receive only an expiring bearer URL; they never receive GCP credentials. */
export async function createArtifactDownloadUrl(key: string, expiresInSeconds = 300) {
  assertArtifactObjectKey(key);
  const config = gcpConfig();
  return createGcpV4SignedArtifactUrl({
    authClient: createGcpWorkloadIdentityClient(config),
    signerServiceAccount: config.artifactSignerServiceAccount,
    bucket: config.artifactBucket,
    objectKey: key,
    method: "GET",
    expiresInSeconds: boundedExpiry(expiresInSeconds),
  });
}

export async function createArtifactUploadUrl(input: {
  key: string;
  contentType: string;
  sha256: string;
  expiresInSeconds?: number;
}) {
  assertArtifactObjectKey(input.key);
  if (!/^[a-f0-9]{64}$/.test(input.sha256)) throw new Error("Invalid artifact upload target.");
  const config = gcpConfig();
  return createGcpV4SignedArtifactUrl({
    authClient: createGcpWorkloadIdentityClient(config),
    signerServiceAccount: config.artifactSignerServiceAccount,
    bucket: config.artifactBucket,
    objectKey: input.key,
    method: "PUT",
    expiresInSeconds: boundedExpiry(input.expiresInSeconds),
    contentType: input.contentType,
    metadata: {
      "x-goog-meta-sha256": input.sha256,
      "x-goog-meta-immutable": "true",
    },
  });
}
