import "server-only";

import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import type { Prisma, Provider, ProviderConnection, SecretVersion } from "@prisma/client";
import { z } from "zod";

import { assertProjectRuntimeSecretNameAllowed, CONTROL_PLANE_SECRET_VALUE_ENV_NAMES } from "@/policy/secret-guard";

import { getDb } from "./db";
import { getRuntimeConfig } from "./env";
import {
  completedPublishedIdempotencyReceiptData,
  completePublishedIdempotencyReceiptInTransaction,
  parsePublishedIdempotencyReceipt,
  readPublishedIdempotencyReceipt,
  secureIdempotencyFingerprint,
  type PublishedIdempotencyClaim,
  type PublishedIdempotencyOutcome,
} from "./published-idempotency";
import { canonicalJson } from "./security/canonical-json";
import { envelopeToPersistence, SecretEnvelopeSchema, type SecretEnvelope } from "./security/encryption";
import { redactValue } from "./security/redaction";
import { getVaultCipher } from "./security/vault-factory";

const providerMap = {
  kimi: "KIMI",
  daytona: "DAYTONA",
  reddit: "REDDIT",
  github: "GITHUB",
  vercel: "VERCEL",
} as const satisfies Record<string, Provider>;

export type VaultProvider = keyof typeof providerMap;

const ProviderCredentialSaveResultSchema = z
  .object({
    connection: z.object({
      id: z.string(),
      health: z.string(),
      accountExternalId: z.string().nullable(),
      accountLabel: z.string().nullable(),
      scopes: z.array(z.string()),
      maskedSuffix: z.string().nullable(),
      lastTestedAt: z.string().nullable(),
      optimisticVersion: z.number().int().nonnegative(),
      replacementPending: z.boolean(),
      hasActiveCredential: z.boolean(),
    }).strict(),
    secretVersion: z.object({
      id: z.string(),
      version: z.number().int().positive(),
      name: z.string(),
      maskedSuffix: z.string(),
    }).strict(),
    pendingMaskedSuffix: z.string(),
    replayed: z.boolean(),
  })
  .strict();

type ProviderCredentialSaveResult = z.infer<typeof ProviderCredentialSaveResultSchema>;

const ProviderCandidateMetadataSchema = z
  .object({
    schemaVersion: z.literal(1),
    provider: z.enum(["kimi", "daytona", "reddit", "github", "vercel"]),
    secretVersionId: z.string(),
    accountLabel: z.string().nullable(),
    accountId: z.string().nullable(),
    scopes: z.array(z.string()),
    authorizationReference: z.string().nullable(),
  })
  .strict();

type ProjectSecretMetadataRecord = {
  id: string;
  name: string;
  version: number;
  maskedSuffix: string;
  revokedAt: string | null;
  createdAt: string;
  replayed: boolean;
};

function constantTimeHexEqual(left: string, right: string) {
  const leftBytes = Buffer.from(left, "hex");
  const rightBytes = Buffer.from(right, "hex");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function projectSecretRequestFingerprint(input: { projectId: string; name: string; value: string }) {
  const signingKey = getRuntimeConfig().auth.secret;
  if (!signingKey) throw new Error("A server signing key is required for project secret idempotency.");
  return createHmac("sha256", signingKey)
    .update(canonicalJson({ projectId: input.projectId, name: input.name, value: input.value }))
    .digest("hex");
}

function projectSecretMetadataFromEvent(
  event: { eventType: string; payload: unknown },
  expected: { projectId: string; name: string; requestFingerprint: string },
): ProjectSecretMetadataRecord {
  if (event.eventType !== "project.secret.versioned" || typeof event.payload !== "object" || event.payload === null) {
    throw new Error("The idempotency key was already used for a different mutation.");
  }
  const payload = event.payload as Record<string, unknown>;
  if (
    typeof payload.id !== "string"
    || typeof payload.name !== "string"
    || typeof payload.version !== "number"
    || typeof payload.maskedSuffix !== "string"
    || typeof payload.createdAt !== "string"
    || typeof payload.projectId !== "string"
    || typeof payload.requestFingerprint !== "string"
  ) {
    throw new Error("Stored secret idempotency metadata is invalid.");
  }
  if (
    payload.projectId !== expected.projectId
    || payload.name !== expected.name
    || !constantTimeHexEqual(payload.requestFingerprint, expected.requestFingerprint)
  ) {
    throw new Error("The idempotency key was already used for different project secret input.");
  }
  return {
    id: payload.id,
    name: payload.name,
    version: payload.version,
    maskedSuffix: payload.maskedSuffix,
    revokedAt: typeof payload.revokedAt === "string" ? payload.revokedAt : null,
    createdAt: payload.createdAt,
    replayed: true,
  };
}

function secretValuesEqual(leftValue: string, rightValue: string) {
  const left = Buffer.from(leftValue.trim(), "utf8");
  const right = Buffer.from(rightValue.trim(), "utf8");
  try {
    return left.length === right.length && timingSafeEqual(left, right);
  } finally {
    left.fill(0);
    right.fill(0);
  }
}

function assertNotControlPlaneEnvironmentSecret(candidate: string) {
  for (const name of CONTROL_PLANE_SECRET_VALUE_ENV_NAMES) {
    const configured = process.env[name];
    if (configured && secretValuesEqual(candidate, configured)) {
      throw new Error("Control-plane credentials cannot be copied into project runtime secrets.");
    }
  }
}

async function assertNotControlPlaneCredential(
  workspaceId: string,
  candidate: string,
  cipher: Awaited<ReturnType<typeof getVaultCipher>>,
) {
  const rows = await getDb().secretVersion.findMany({
    where: { workspaceId, scope: "CONTROL_PLANE", revokedAt: null },
    include: { providerConnection: { select: { provider: true } } },
  });
  for (const row of rows) {
    const provider = (Object.entries(providerMap).find(([, value]) => value === row.providerConnection?.provider)?.[0] ?? null) as VaultProvider | null;
    if (!provider) throw new Error("Stored control-plane credential metadata is invalid.");
    const plaintext = await cipher.decrypt(envelopeFromRow(row), {
      workspaceId,
      provider,
      secretName: row.name,
      version: row.version,
      projectId: null,
    });
    if (secretValuesEqual(candidate, plaintext)) {
      throw new Error("Control-plane credentials cannot be copied into project runtime secrets.");
    }
  }
}

function suffix(value: string) {
  const normalized = value.trim();
  return normalized.slice(-4).padStart(4, "•");
}

function envelopeFromRow(row: SecretVersion) {
  return SecretEnvelopeSchema.parse({
    schemaVersion: 1,
    algorithm: "AES-256-GCM",
    keyProvider: row.keyProvider,
    keyId: row.keyId,
    ciphertext: Buffer.from(row.ciphertext).toString("base64"),
    wrappedDataKey: Buffer.from(row.wrappedDataKey).toString("base64"),
    iv: Buffer.from(row.iv).toString("base64"),
    authTag: Buffer.from(row.authTag).toString("base64"),
    wrapIv: row.wrapIv ? Buffer.from(row.wrapIv).toString("base64") : null,
    wrapAuthTag: row.wrapAuthTag ? Buffer.from(row.wrapAuthTag).toString("base64") : null,
    contextHash: row.contextHash,
  });
}

function secretCreateFields(envelope: SecretEnvelope) {
  const stored = envelopeToPersistence(envelope);
  return {
    algorithm: stored.algorithm,
    keyProvider: stored.keyProvider,
    keyId: stored.keyId,
    ciphertext: Uint8Array.from(stored.ciphertext),
    wrappedDataKey: Uint8Array.from(stored.wrappedDataKey),
    iv: Uint8Array.from(stored.iv),
    authTag: Uint8Array.from(stored.authTag),
    wrapIv: stored.wrapIv ? Uint8Array.from(stored.wrapIv) : null,
    wrapAuthTag: stored.wrapAuthTag ? Uint8Array.from(stored.wrapAuthTag) : null,
    contextHash: stored.contextHash,
  };
}

function providerCredentialOperation(provider: VaultProvider) {
  return `connection.credential.put.${provider}`;
}

function providerCredentialFingerprint(input: {
  provider: VaultProvider;
  credential: string;
  maskedValue?: string;
  accountLabel?: string;
  accountId?: string;
  scopes?: string[];
  authorizationReference?: string;
  expectedConnectionVersion?: number;
}) {
  return secureIdempotencyFingerprint(providerCredentialOperation(input.provider), {
    provider: input.provider,
    credential: input.credential,
    maskedValue: input.maskedValue ?? null,
    accountLabel: input.accountLabel ?? null,
    accountId: input.accountId ?? null,
    scopes: input.scopes ?? [],
    authorizationReference: input.authorizationReference ?? null,
    expectedConnectionVersion: input.expectedConnectionVersion ?? null,
  });
}

function providerCredentialReplay(
  event: { eventType: string; payload: unknown; payloadHash: string },
  expected: { operation: string; requestFingerprint: string },
) {
  const receipt = parsePublishedIdempotencyReceipt(event, expected);
  if (!receipt.outcome) throw new Error("The credential request with this idempotency key is still in progress.");
  if (!receipt.outcome.ok) throw new Error(receipt.outcome.error.message);
  return ProviderCredentialSaveResultSchema.parse({
    ...ProviderCredentialSaveResultSchema.parse(receipt.outcome.response),
    replayed: true,
  });
}

function candidateMetadataEventData(input: {
  workspaceId: string;
  provider: VaultProvider;
  secretVersionId: string;
  version: number;
  accountLabel?: string;
  accountId?: string;
  scopes?: string[];
  authorizationReference?: string;
}) {
  const payload = ProviderCandidateMetadataSchema.parse({
    schemaVersion: 1,
    provider: input.provider,
    secretVersionId: input.secretVersionId,
    accountLabel: input.accountLabel ?? null,
    accountId: input.accountId ?? null,
    scopes: input.scopes ?? [],
    authorizationReference: input.authorizationReference ?? null,
  });
  return {
    workspaceId: input.workspaceId,
    aggregateType: "provider_credential_candidate",
    aggregateId: input.secretVersionId,
    aggregateVersion: input.version,
    eventType: "provider.credential.candidate.staged",
    payload,
    payloadHash: createHash("sha256").update(canonicalJson(payload)).digest("hex"),
    idempotencyKey: `internal:provider-candidate:${input.secretVersionId}`,
    publishedAt: new Date(),
  };
}

async function pendingCandidateMetadata(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  secretVersionId: string,
) {
  const event = await tx.outboxEvent.findFirst({
    where: {
      workspaceId,
      aggregateType: "provider_credential_candidate",
      aggregateId: secretVersionId,
      eventType: "provider.credential.candidate.staged",
    },
    select: { payload: true, payloadHash: true },
  });
  if (!event) return null;
  return parseCandidateMetadataEvent(event, secretVersionId);
}

function parseCandidateMetadataEvent(
  event: { payload: unknown; payloadHash: string },
  secretVersionId: string,
) {
  const metadata = ProviderCandidateMetadataSchema.parse(event.payload);
  const expectedHash = createHash("sha256").update(canonicalJson(metadata)).digest("hex");
  if (!constantTimeHexEqual(event.payloadHash, expectedHash) || metadata.secretVersionId !== secretVersionId) {
    throw new Error("Stored provider credential candidate metadata is invalid.");
  }
  return metadata;
}

export function stagedProviderCredentialConnectionUpdate(input: {
  pendingSecretVersionId: string;
  pendingMaskedSuffix: string;
  hasActiveCredential: boolean;
  accountLabel: string | null;
  accountExternalId: string | null;
  scopes: string[];
  authorizationReference: string | null;
}) {
  if (input.hasActiveCredential) return { pendingSecretVersionId: input.pendingSecretVersionId };
  return {
    pendingSecretVersionId: input.pendingSecretVersionId,
    activeSecretVersionId: null,
    maskedSuffix: input.pendingMaskedSuffix,
    health: "PENDING" as const,
    accountLabel: input.accountLabel,
    accountExternalId: input.accountExternalId,
    scopes: input.scopes,
    authorizationRef: input.authorizationReference,
    authorizedAt: input.authorizationReference ? new Date() : null,
    lastTestedAt: null,
    lastHealthyAt: null,
    failureCode: null,
    failureMessage: null,
    connectedAt: null,
    disconnectedAt: null,
  };
}

export function failedProviderCredentialConnectionUpdate(input: {
  activeUsable: boolean;
  failureCode?: string;
  failureMessage?: string;
  testedAt: Date;
}) {
  if (input.activeUsable) return { pendingSecretVersionId: null };
  return {
    pendingSecretVersionId: null,
    activeSecretVersionId: null,
    health: "DEGRADED" as const,
    accountExternalId: null,
    accountLabel: null,
    scopes: [] as string[],
    maskedSuffix: null,
    authorizationRef: null,
    authorizedAt: null,
    lastTestedAt: input.testedAt,
    failureCode: input.failureCode ?? "provider_test_failed",
    failureMessage: input.failureMessage ?? null,
  };
}

export async function saveProviderCredential(input: {
  workspaceId: string;
  provider: VaultProvider;
  credential: string;
  maskedValue?: string;
  accountLabel?: string;
  accountId?: string;
  scopes?: string[];
  authorizationReference?: string;
  expectedConnectionVersion?: number;
  createdByUserId: string;
  idempotencyKey?: string;
  requestId?: string;
}) {
  const db = getDb();
  const operation = providerCredentialOperation(input.provider);
  const requestFingerprint = input.idempotencyKey ? providerCredentialFingerprint(input) : null;
  if (input.idempotencyKey && requestFingerprint) {
    const existing = await readPublishedIdempotencyReceipt({
      workspaceId: input.workspaceId,
      idempotencyKey: input.idempotencyKey,
      operation,
      requestFingerprint,
    });
    if (existing) {
      if (!existing.outcome) throw new Error("The credential request with this idempotency key is still in progress.");
      if (!existing.outcome.ok) throw new Error(existing.outcome.error.message);
      return ProviderCredentialSaveResultSchema.parse({
        ...ProviderCredentialSaveResultSchema.parse(existing.outcome.response),
        replayed: true,
      });
    }
  }
  const cipher = await getVaultCipher();
  try {
    return await db.$transaction(
      async (tx) => {
        if (input.idempotencyKey && requestFingerprint) {
          const replay = await tx.outboxEvent.findUnique({
            where: { workspaceId_idempotencyKey: { workspaceId: input.workspaceId, idempotencyKey: input.idempotencyKey } },
            select: { eventType: true, payload: true, payloadHash: true },
          });
          if (replay) return providerCredentialReplay(replay, { operation, requestFingerprint });
        }
      const provider = providerMap[input.provider];
        let connection = await tx.providerConnection.findUnique({
          where: { workspaceId_provider: { workspaceId: input.workspaceId, provider } },
          include: { activeSecretVersion: { select: { id: true, revokedAt: true } } },
        });
        if (!connection) {
          if (input.expectedConnectionVersion !== undefined && input.expectedConnectionVersion !== 0) {
            throw new Error("Connection version conflict.");
          }
          connection = await tx.providerConnection.create({
            data: {
          workspaceId: input.workspaceId,
          provider,
          health: "PENDING",
          accountLabel: input.accountLabel ?? null,
          accountExternalId: input.accountId ?? null,
          scopes: input.scopes ?? [],
          authorizationRef: input.authorizationReference ?? null,
          authorizedAt: input.authorizationReference ? new Date() : null,
            },
            include: { activeSecretVersion: { select: { id: true, revokedAt: true } } },
          });
        } else if (
          input.expectedConnectionVersion !== undefined
          && connection.optimisticVersion !== input.expectedConnectionVersion
        ) {
          throw new Error("Connection version conflict.");
        }
        const hasActiveCredential = Boolean(connection.activeSecretVersion && !connection.activeSecretVersion.revokedAt);
      const logicalKey = `provider:${input.provider}:credential`;
      const latest = await tx.secretVersion.aggregate({
        where: { workspaceId: input.workspaceId, logicalKey },
        _max: { version: true },
      });
      const version = (latest._max.version ?? 0) + 1;
      const envelope = await cipher.encrypt(input.credential, {
        workspaceId: input.workspaceId,
        provider: input.provider,
        secretName: "credential",
        version,
        projectId: null,
      });
      const secret = await tx.secretVersion.create({
        data: {
          workspaceId: input.workspaceId,
          providerConnectionId: connection.id,
          scope: "CONTROL_PLANE",
          logicalKey,
          name: "credential",
          version,
          maskedSuffix: suffix(input.maskedValue ?? input.credential),
          createdByUserId: input.createdByUserId,
          ...secretCreateFields(envelope),
        },
      });
      if (connection.pendingSecretVersionId) {
        await tx.secretVersion.update({ where: { id: connection.pendingSecretVersionId }, data: { revokedAt: new Date() } });
      }
      const updated = await tx.providerConnection.update({
        where: { id: connection.id, optimisticVersion: connection.optimisticVersion },
        data: {
          ...stagedProviderCredentialConnectionUpdate({
            pendingSecretVersionId: secret.id,
            pendingMaskedSuffix: secret.maskedSuffix,
            hasActiveCredential,
            accountLabel: input.accountLabel ?? null,
            accountExternalId: input.accountId ?? null,
            scopes: input.scopes ?? [],
            authorizationReference: input.authorizationReference ?? null,
          }),
          optimisticVersion: { increment: 1 },
        },
      });
        await tx.outboxEvent.create({ data: candidateMetadataEventData({
          workspaceId: input.workspaceId,
          provider: input.provider,
          secretVersionId: secret.id,
          version,
          ...(input.accountLabel !== undefined ? { accountLabel: input.accountLabel } : {}),
          ...(input.accountId !== undefined ? { accountId: input.accountId } : {}),
          ...(input.scopes !== undefined ? { scopes: input.scopes } : {}),
          ...(input.authorizationReference !== undefined ? { authorizationReference: input.authorizationReference } : {}),
        }) });
        const result: ProviderCredentialSaveResult = {
          connection: {
            id: updated.id,
            health: updated.health,
            accountExternalId: updated.accountExternalId,
            accountLabel: updated.accountLabel,
            scopes: updated.scopes,
            maskedSuffix: updated.maskedSuffix,
            lastTestedAt: updated.lastTestedAt?.toISOString() ?? null,
            optimisticVersion: updated.optimisticVersion,
            replacementPending: true,
            hasActiveCredential,
          },
          secretVersion: { id: secret.id, version, name: secret.name, maskedSuffix: secret.maskedSuffix },
          pendingMaskedSuffix: secret.maskedSuffix,
          replayed: false,
        };
        if (input.idempotencyKey && requestFingerprint) {
          await tx.outboxEvent.create({
            data: completedPublishedIdempotencyReceiptData({
              workspaceId: input.workspaceId,
              idempotencyKey: input.idempotencyKey,
              operation,
              requestFingerprint,
              outcome: { ok: true, response: result },
            }),
          });
        }
        if (input.requestId) {
          await tx.auditEvent.create({
            data: {
              workspaceId: input.workspaceId,
              actorUserId: input.createdByUserId,
              action: "connection.credential.versioned",
              targetType: "provider_connection",
              targetId: updated.id,
              requestId: input.requestId,
              metadata: redactValue({
                provider: input.provider,
                secretVersion: secret.version,
                maskedSuffix: secret.maskedSuffix,
                replacement: hasActiveCredential,
              }) as Prisma.InputJsonValue,
              expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60_000),
            },
          });
        }
        return result;
      },
      { isolationLevel: "Serializable", timeout: 20_000 },
    );
  } catch (error) {
    if (input.idempotencyKey && requestFingerprint) {
      const replay = await db.outboxEvent.findUnique({
        where: { workspaceId_idempotencyKey: { workspaceId: input.workspaceId, idempotencyKey: input.idempotencyKey } },
        select: { eventType: true, payload: true, payloadHash: true },
      });
      if (replay) return providerCredentialReplay(replay, { operation, requestFingerprint });
    }
    throw error;
  }
}

export async function readProviderCredential(input: { workspaceId: string; provider: VaultProvider; usePending?: boolean }) {
  const connection = await getDb().providerConnection.findUnique({
    where: { workspaceId_provider: { workspaceId: input.workspaceId, provider: providerMap[input.provider] } },
    include: { activeSecretVersion: true, pendingSecretVersion: true },
  });
  const row = input.usePending ? (connection?.pendingSecretVersion ?? connection?.activeSecretVersion) : connection?.activeSecretVersion;
  if (!row || row.revokedAt) throw new Error(`${input.provider} has no testable active or pending credential.`);
  return getVaultCipher().then((cipher) =>
    cipher.decrypt(envelopeFromRow(row), {
      workspaceId: input.workspaceId,
      provider: input.provider,
      secretName: row.name,
      version: row.version,
      projectId: null,
    }),
  );
}

export class ProviderCredentialTestReadError extends Error {
  constructor(
    message: string,
    public readonly secretVersionId: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ProviderCredentialTestReadError";
  }
}

/** Returns the exact version selected for a provider test so promotion can be fenced against replacement races. */
export async function readProviderCredentialForTest(input: { workspaceId: string; provider: VaultProvider }) {
  const db = getDb();
  const connection = await db.providerConnection.findUnique({
    where: { workspaceId_provider: { workspaceId: input.workspaceId, provider: providerMap[input.provider] } },
    include: { activeSecretVersion: true, pendingSecretVersion: true },
  });
  const pending = connection?.pendingSecretVersion && !connection.pendingSecretVersion.revokedAt
    ? connection.pendingSecretVersion
    : null;
  const row = pending ?? connection?.activeSecretVersion;
  if (!row || row.revokedAt) throw new Error(`${input.provider} has no testable active or pending credential.`);
  try {
    const credential = await getVaultCipher().then((cipher) =>
      cipher.decrypt(envelopeFromRow(row), {
        workspaceId: input.workspaceId,
        provider: input.provider,
        secretName: row.name,
        version: row.version,
        projectId: null,
      }),
    );
    let authorizationReference = connection?.authorizationRef ?? null;
    if (pending?.id === row.id) {
      const event = await db.outboxEvent.findFirst({
        where: {
          workspaceId: input.workspaceId,
          aggregateType: "provider_credential_candidate",
          aggregateId: row.id,
          eventType: "provider.credential.candidate.staged",
        },
        select: { payload: true, payloadHash: true },
      });
      if (event) authorizationReference = parseCandidateMetadataEvent(event, row.id).authorizationReference ?? authorizationReference;
    }
    return {
      credential,
      secretVersionId: row.id,
      version: row.version,
      pending: row.id === pending?.id,
      authorizationReference,
    };
  } catch (error) {
    throw new ProviderCredentialTestReadError("The selected provider credential could not be read for testing.", row.id, { cause: error });
  }
}

export function decideProviderCredentialTest(input: {
  activeSecretVersionId: string | null;
  pendingSecretVersionId: string | null;
  testedSecretVersionId?: string;
  healthy: boolean;
}) {
  const testedPending = Boolean(
    input.pendingSecretVersionId
    && (!input.testedSecretVersionId || input.pendingSecretVersionId === input.testedSecretVersionId),
  );
  const testedActive = Boolean(
    input.activeSecretVersionId
    && input.testedSecretVersionId
    && input.activeSecretVersionId === input.testedSecretVersionId,
  );
  if (input.testedSecretVersionId && !testedPending && !testedActive) return "stale" as const;
  if (input.pendingSecretVersionId && testedPending) {
    if (input.healthy) return "promote_pending" as const;
    return input.activeSecretVersionId ? "reject_pending_preserve_active" as const : "reject_pending_without_active" as const;
  }
  return "update_active" as const;
}

export async function markConnectionTest(input: {
  workspaceId: string;
  provider: VaultProvider;
  healthy: boolean;
  accountId?: string;
  accountLabel?: string;
  scopes?: string[];
  failureCode?: string;
  failureMessage?: string;
  testedSecretVersionId?: string;
  expectedConnectionVersion?: number;
  idempotencyCompletion?: {
    claim: PublishedIdempotencyClaim;
    operation: string;
    requestFingerprint: string;
    outcome: (connection: ProviderConnection) => PublishedIdempotencyOutcome;
    audit?: (connection: ProviderConnection) => {
      actorUserId?: string;
      action: string;
      targetType: string;
      targetId: string;
      requestId?: string;
      metadata: Prisma.InputJsonValue;
    };
  };
}) {
  const current = new Date();
  return getDb().$transaction(async (tx) => {
    const connection = await tx.providerConnection.findUniqueOrThrow({
      where: { workspaceId_provider: { workspaceId: input.workspaceId, provider: providerMap[input.provider] } },
      include: { activeSecretVersion: true, pendingSecretVersion: true },
    });
    if (
      input.expectedConnectionVersion !== undefined
      && connection.optimisticVersion !== input.expectedConnectionVersion
    ) {
      throw new Error("Connection version conflict.");
    }
    const finalize = async (updated: ProviderConnection) => {
      if (input.idempotencyCompletion) {
        await completePublishedIdempotencyReceiptInTransaction(tx, {
          workspaceId: input.workspaceId,
          claim: input.idempotencyCompletion.claim,
          operation: input.idempotencyCompletion.operation,
          requestFingerprint: input.idempotencyCompletion.requestFingerprint,
          outcome: input.idempotencyCompletion.outcome(updated),
          ...(input.idempotencyCompletion.audit
            ? { audit: input.idempotencyCompletion.audit(updated) }
            : {}),
        });
      }
      return updated;
    };

    const disposition = decideProviderCredentialTest({
      activeSecretVersionId: connection.activeSecretVersionId,
      pendingSecretVersionId: connection.pendingSecretVersionId,
      ...(input.testedSecretVersionId ? { testedSecretVersionId: input.testedSecretVersionId } : {}),
      healthy: input.healthy,
    });
    if (disposition === "stale") {
      throw new Error("Connection test result is stale because the credential candidate changed.");
    }

    if (disposition === "promote_pending" && connection.pendingSecretVersionId) {
      const candidate = await pendingCandidateMetadata(tx, input.workspaceId, connection.pendingSecretVersionId);
      if (candidate && candidate.provider !== input.provider) {
        throw new Error("Stored provider credential candidate metadata belongs to a different provider.");
      }
      if (connection.activeSecretVersionId && connection.activeSecretVersionId !== connection.pendingSecretVersionId) {
        await tx.secretVersion.update({ where: { id: connection.activeSecretVersionId }, data: { revokedAt: current } });
      }
      const authorizationReference = candidate?.authorizationReference ?? connection.authorizationRef;
      return finalize(await tx.providerConnection.update({
        where: { id: connection.id, optimisticVersion: connection.optimisticVersion },
        data: {
          activeSecretVersionId: connection.pendingSecretVersionId,
          pendingSecretVersionId: null,
          maskedSuffix: connection.pendingSecretVersion?.maskedSuffix ?? connection.maskedSuffix,
          health: "HEALTHY",
          lastTestedAt: current,
          lastHealthyAt: current,
          accountExternalId: input.accountId ?? candidate?.accountId ?? connection.accountExternalId,
          accountLabel: input.accountLabel ?? candidate?.accountLabel ?? connection.accountLabel,
          scopes: input.scopes ?? (candidate?.scopes.length ? candidate.scopes : connection.scopes),
          authorizationRef: authorizationReference,
          authorizedAt: authorizationReference ? current : connection.authorizedAt,
          connectedAt: current,
          disconnectedAt: null,
          failureCode: null,
          failureMessage: null,
          optimisticVersion: { increment: 1 },
        },
      }));
    }

    if ((disposition === "reject_pending_preserve_active" || disposition === "reject_pending_without_active") && connection.pendingSecretVersionId) {
      await tx.secretVersion.updateMany({
        where: { id: connection.pendingSecretVersionId, workspaceId: input.workspaceId, revokedAt: null },
        data: { revokedAt: current },
      });
      const activeUsable = disposition === "reject_pending_preserve_active"
        && Boolean(connection.activeSecretVersion && !connection.activeSecretVersion.revokedAt);
      return finalize(await tx.providerConnection.update({
        where: { id: connection.id, optimisticVersion: connection.optimisticVersion },
        data: {
          ...failedProviderCredentialConnectionUpdate({
            activeUsable,
            ...(input.failureCode ? { failureCode: input.failureCode } : {}),
            ...(input.failureMessage ? { failureMessage: input.failureMessage } : {}),
            testedAt: current,
          }),
          optimisticVersion: { increment: 1 },
        },
      }));
    }

    return finalize(await tx.providerConnection.update({
      where: { id: connection.id, optimisticVersion: connection.optimisticVersion },
      data: {
        health: input.healthy ? "HEALTHY" : "DEGRADED",
        lastTestedAt: current,
        ...(input.healthy ? { lastHealthyAt: current } : {}),
        ...(input.accountId !== undefined ? { accountExternalId: input.accountId } : {}),
        ...(input.accountLabel !== undefined ? { accountLabel: input.accountLabel } : {}),
        ...(input.scopes !== undefined ? { scopes: input.scopes } : {}),
        failureCode: input.failureCode ?? null,
        failureMessage: input.failureMessage ?? null,
        optimisticVersion: { increment: 1 },
      },
    }));
  });
}

export async function saveOAuthConnection(input: {
  workspaceId: string;
  provider: "github" | "vercel";
  accountId: string;
  accountLabel: string;
  scopes: string[];
}) {
  return getDb().providerConnection.upsert({
    where: { workspaceId_provider: { workspaceId: input.workspaceId, provider: providerMap[input.provider] } },
    create: {
      workspaceId: input.workspaceId,
      provider: providerMap[input.provider],
      health: "HEALTHY",
      accountExternalId: input.accountId,
      accountLabel: input.accountLabel,
      scopes: input.scopes,
      maskedSuffix: input.accountId.slice(-4),
      lastTestedAt: new Date(),
      lastHealthyAt: new Date(),
      connectedAt: new Date(),
    },
    update: {
      health: "HEALTHY",
      accountExternalId: input.accountId,
      accountLabel: input.accountLabel,
      scopes: input.scopes,
      maskedSuffix: input.accountId.slice(-4),
      lastTestedAt: new Date(),
      lastHealthyAt: new Date(),
      connectedAt: new Date(),
      disconnectedAt: null,
      optimisticVersion: { increment: 1 },
    },
  });
}

export async function disconnectProvider(input: {
  workspaceId: string;
  provider: VaultProvider;
  expectedConnectionVersion: number;
  allowRecoveredVersion?: boolean;
}) {
  const db = getDb();
  return db.$transaction(async (tx) => {
    const connection = await tx.providerConnection.findUnique({
      where: { workspaceId_provider: { workspaceId: input.workspaceId, provider: providerMap[input.provider] } },
    });
    if (!connection) throw new Error("Connection not found.");
    if (connection.optimisticVersion !== input.expectedConnectionVersion) {
      if (
        input.allowRecoveredVersion
        && connection.optimisticVersion === input.expectedConnectionVersion + 1
        && connection.health === "DISCONNECTED"
      ) return connection;
      throw new Error("Connection version conflict.");
    }
    await tx.secretVersion.updateMany({
      where: { providerConnectionId: connection.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return tx.providerConnection.update({
      where: { id: connection.id, optimisticVersion: connection.optimisticVersion },
      data: {
        health: "DISCONNECTED",
        activeSecretVersionId: null,
        pendingSecretVersionId: null,
        maskedSuffix: null,
        disconnectedAt: new Date(),
        optimisticVersion: { increment: 1 },
      },
    });
  });
}

export async function saveProjectSecret(input: {
  workspaceId: string;
  projectId: string;
  name: string;
  value: string;
  createdByUserId: string;
  idempotencyKey: string;
  expectedProjectVersion: number;
  purpose: string;
  requestId: string;
}) {
  assertProjectRuntimeSecretNameAllowed(input.name);
  const db = getDb();
  const requestFingerprint = projectSecretRequestFingerprint(input);
  const existing = await db.outboxEvent.findUnique({
    where: { workspaceId_idempotencyKey: { workspaceId: input.workspaceId, idempotencyKey: input.idempotencyKey } },
    select: { eventType: true, payload: true },
  });
  if (existing) return projectSecretMetadataFromEvent(existing, { projectId: input.projectId, name: input.name, requestFingerprint });
  const cipher = await getVaultCipher();
  assertNotControlPlaneEnvironmentSecret(input.value);
  await assertNotControlPlaneCredential(input.workspaceId, input.value, cipher);
  try {
    return await db.$transaction(
      async (tx) => {
        const replay = await tx.outboxEvent.findUnique({
          where: { workspaceId_idempotencyKey: { workspaceId: input.workspaceId, idempotencyKey: input.idempotencyKey } },
          select: { eventType: true, payload: true },
        });
        if (replay) return projectSecretMetadataFromEvent(replay, { projectId: input.projectId, name: input.name, requestFingerprint });
        const project = await tx.project.findUnique({ where: { workspaceId_id: { workspaceId: input.workspaceId, id: input.projectId } } });
        if (!project) throw new Error("Project not found.");
        if (project.optimisticVersion !== input.expectedProjectVersion) throw new Error("Project version conflict.");
        if (project.archivedAt || project.status === "ARCHIVED") throw new Error("Archived projects cannot accept new secret versions.");
        const logicalKey = `project:${input.projectId}:${input.name}`;
        const latest = await tx.secretVersion.aggregate({
          where: { workspaceId: input.workspaceId, logicalKey },
          _max: { version: true },
        });
        const version = (latest._max.version ?? 0) + 1;
        const envelope = await cipher.encrypt(input.value, {
          workspaceId: input.workspaceId,
          provider: "project-runtime",
          secretName: input.name,
          version,
          projectId: input.projectId,
        });
        const secret = await tx.secretVersion.create({
          data: {
            workspaceId: input.workspaceId,
            projectId: input.projectId,
            scope: "PROJECT_RUNTIME",
            logicalKey,
            name: input.name,
            version,
            maskedSuffix: suffix(input.value),
            createdByUserId: input.createdByUserId,
            ...secretCreateFields(envelope),
          },
        });
        const metadata = {
          id: secret.id,
          projectId: input.projectId,
          name: secret.name,
          version: secret.version,
          maskedSuffix: secret.maskedSuffix,
          revokedAt: secret.revokedAt?.toISOString() ?? null,
          createdAt: secret.createdAt.toISOString(),
          replayed: false,
          requestFingerprint,
        };
        const payloadHash = createHash("sha256").update(canonicalJson(metadata)).digest("hex");
        await tx.outboxEvent.create({
          data: {
            workspaceId: input.workspaceId,
            aggregateType: "secret_version",
            aggregateId: secret.id,
            aggregateVersion: secret.version,
            eventType: "project.secret.versioned",
            payload: metadata,
            payloadHash,
            idempotencyKey: input.idempotencyKey,
            publishedAt: new Date(),
          },
        });
        await tx.auditEvent.create({
          data: {
            workspaceId: input.workspaceId,
            actorUserId: input.createdByUserId,
            action: "project.secret.versioned",
            targetType: "secret_version",
            targetId: secret.id,
            requestId: input.requestId,
            metadata: redactValue({
              projectId: input.projectId,
              name: secret.name,
              version: secret.version,
              maskedSuffix: secret.maskedSuffix,
              purpose: input.purpose,
            }) as Prisma.InputJsonValue,
            expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60_000),
          },
        });
        return {
          id: metadata.id,
          name: metadata.name,
          version: metadata.version,
          maskedSuffix: metadata.maskedSuffix,
          revokedAt: metadata.revokedAt,
          createdAt: metadata.createdAt,
          replayed: false,
        };
      },
      { isolationLevel: "Serializable", timeout: 20_000 },
    );
  } catch (error) {
    const replay = await db.outboxEvent.findUnique({
      where: { workspaceId_idempotencyKey: { workspaceId: input.workspaceId, idempotencyKey: input.idempotencyKey } },
      select: { eventType: true, payload: true },
    });
    if (replay) return projectSecretMetadataFromEvent(replay, { projectId: input.projectId, name: input.name, requestFingerprint });
    throw error;
  }
}

export async function listProjectSecretMetadata(input: { workspaceId: string; projectId: string }) {
  const db = getDb();
  const project = await db.project.findUnique({
    where: { workspaceId_id: { workspaceId: input.workspaceId, id: input.projectId } },
    select: { id: true, optimisticVersion: true },
  });
  if (!project) throw new Error("Project not found.");
  const rows = await db.secretVersion.findMany({
    where: {
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      scope: "PROJECT_RUNTIME",
    },
    select: {
      id: true,
      name: true,
      version: true,
      maskedSuffix: true,
      revokedAt: true,
      createdAt: true,
      grants: {
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          approvalId: true,
          deploymentId: true,
          status: true,
          grantedAt: true,
          revokedAt: true,
          createdAt: true,
        },
      },
    },
    orderBy: [{ name: "asc" }, { version: "desc" }],
  });
  const latestNames = new Set<string>();
  return {
    projectOptimisticVersion: project.optimisticVersion,
    items: rows.map((row) => {
      const isLatest = !latestNames.has(row.name);
      latestNames.add(row.name);
      return {
        id: row.id,
        name: row.name,
        version: row.version,
        maskedSuffix: row.maskedSuffix,
        isLatest,
        status: row.revokedAt ? "revoked" : "active",
        revokedAt: row.revokedAt?.toISOString() ?? null,
        createdAt: row.createdAt.toISOString(),
        grants: row.grants.map((grant) => ({
          id: grant.id,
          approvalId: grant.approvalId,
          deploymentId: grant.deploymentId,
          status: grant.status.toLowerCase(),
          grantedAt: grant.grantedAt?.toISOString() ?? null,
          revokedAt: grant.revokedAt?.toISOString() ?? null,
          createdAt: grant.createdAt.toISOString(),
        })),
      };
    }),
  };
}

export async function getLatestGrantableArtifactMetadata(input: { workspaceId: string; projectId: string }) {
  const reports = await getDb().verificationReport.findMany({
    where: {
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      status: "PASSED",
    },
    include: { artifact: true },
    orderBy: [{ verifiedAt: "desc" }, { createdAt: "desc" }],
    take: 25,
  });
  const now = Date.now();
  const report = reports.find((candidate) =>
    (!candidate.expiresAt || candidate.expiresAt.getTime() > now)
    && (!candidate.artifact.expiresAt || candidate.artifact.expiresAt.getTime() > now),
  );
  if (!report) return null;
  return {
    artifactId: report.artifact.id,
    artifactHash: report.artifact.artifactHash,
    verificationReportId: report.id,
    verificationReportHash: report.reportHash,
    verifiedAt: report.verifiedAt?.toISOString() ?? null,
    expiresAt: report.expiresAt?.toISOString() ?? report.artifact.expiresAt?.toISOString() ?? null,
  };
}

export async function readProjectSecretVersion(input: {
  workspaceId: string;
  projectId: string;
  secretVersionId: string;
  name: string;
  version: number;
}) {
  const row = await getDb().secretVersion.findFirst({
    where: {
      id: input.secretVersionId,
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      name: input.name,
      version: input.version,
      scope: "PROJECT_RUNTIME",
      revokedAt: null,
    },
  });
  if (!row) throw new Error(`Approved project secret version is unavailable: ${input.name} v${input.version}.`);
  return getVaultCipher().then((cipher) =>
    cipher.decrypt(envelopeFromRow(row), {
      workspaceId: input.workspaceId,
      provider: "project-runtime",
      secretName: input.name,
      version: input.version,
      projectId: input.projectId,
    }),
  );
}
