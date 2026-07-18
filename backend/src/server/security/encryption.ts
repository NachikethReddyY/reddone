import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

import { z } from "zod";

import { canonicalJson } from "./canonical-json";

const MAX_SECRET_BYTES = 64 * 1024;

export const SecretEncryptionContextSchema = z
  .object({
    workspaceId: z.string().trim().min(1).max(128),
    provider: z.string().trim().min(1).max(100),
    secretName: z.string().trim().min(1).max(100),
    version: z.number().int().positive(),
    projectId: z.string().trim().min(1).max(128).nullable().default(null),
  })
  .strict();

const Base64Schema = z.string().min(1).max(100_000).refine(isCanonicalBase64, "Expected canonical base64");

export const SecretEnvelopeSchema = z
  .object({
    schemaVersion: z.literal(1),
    algorithm: z.literal("AES-256-GCM"),
    keyProvider: z.enum(["local", "aws-kms", "gcp-kms"]),
    keyId: z.string().min(1).max(500),
    ciphertext: Base64Schema,
    wrappedDataKey: Base64Schema,
    iv: Base64Schema,
    authTag: Base64Schema,
    wrapIv: Base64Schema.nullable(),
    wrapAuthTag: Base64Schema.nullable(),
    contextHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict()
  .superRefine((envelope, context) => {
    const hasBothLocalFields = envelope.wrapIv !== null && envelope.wrapAuthTag !== null;
    const hasAnyLocalField = envelope.wrapIv !== null || envelope.wrapAuthTag !== null;
    if (envelope.keyProvider === "local" && !hasBothLocalFields) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["wrapIv"],
        message: "Local envelopes require wrapping IV and authentication tag",
      });
    }
    if ((envelope.keyProvider === "aws-kms" || envelope.keyProvider === "gcp-kms") && hasAnyLocalField) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["wrapIv"],
        message: "KMS envelopes cannot contain local wrapping fields",
      });
    }
  });

export type SecretEncryptionContext = z.input<typeof SecretEncryptionContextSchema>;
export type NormalizedSecretEncryptionContext = z.output<typeof SecretEncryptionContextSchema>;
export type SecretEnvelope = z.infer<typeof SecretEnvelopeSchema>;

export interface SecretCipher {
  encrypt(plaintext: string, context: SecretEncryptionContext): Promise<SecretEnvelope>;
  decrypt(envelope: SecretEnvelope, context: SecretEncryptionContext): Promise<string>;
}

export interface KmsDataKeyProvider {
  generateDataKey(context: Readonly<Record<string, string>>): Promise<{
    plaintextDataKey: Uint8Array;
    encryptedDataKey: Uint8Array;
    keyId: string;
  }>;
  decryptDataKey(
    encryptedDataKey: Uint8Array,
    context: Readonly<Record<string, string>>,
    keyId: string,
  ): Promise<Uint8Array>;
}

export interface SecretVersionPersistence {
  algorithm: "A256GCM";
  keyProvider: "local" | "aws-kms" | "gcp-kms";
  keyId: string;
  ciphertext: Buffer;
  wrappedDataKey: Buffer;
  iv: Buffer;
  authTag: Buffer;
  wrapIv: Buffer | null;
  wrapAuthTag: Buffer | null;
  contextHash: string;
}

export type VaultCipherConfiguration =
  | { kind: "local"; masterKey: string }
  | { kind: "aws-kms" }
  | { kind: "gcp-kms" }
  | { kind: "unavailable" };

function isCanonicalBase64(value: string): boolean {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) return false;
  try {
    return Buffer.from(value, "base64").toString("base64") === value;
  } catch {
    return false;
  }
}

function normalizeContext(context: SecretEncryptionContext): NormalizedSecretEncryptionContext {
  return SecretEncryptionContextSchema.parse(context);
}

function contextMaterial(context: SecretEncryptionContext): {
  normalized: NormalizedSecretEncryptionContext;
  aad: Buffer;
  hash: string;
  kmsContext: Readonly<Record<string, string>>;
} {
  const normalized = normalizeContext(context);
  const canonical = canonicalJson(normalized);
  const aad = Buffer.from(canonical, "utf8");
  const hash = createHash("sha256").update(aad).digest("hex");
  return {
    normalized,
    aad,
    hash,
    kmsContext: {
      workspaceId: normalized.workspaceId,
      provider: normalized.provider,
      secretName: normalized.secretName,
      version: String(normalized.version),
      projectId: normalized.projectId ?? "control-plane",
      contextHash: hash,
    },
  };
}

function assertContextHash(actual: string, expected: string): void {
  if (!/^[a-f0-9]{64}$/.test(actual)) throw new Error("Secret context mismatch");
  const actualBytes = Buffer.from(actual, "hex");
  const expectedBytes = Buffer.from(expected, "hex");
  if (actualBytes.length !== expectedBytes.length || !timingSafeEqual(actualBytes, expectedBytes)) {
    throw new Error("Secret context mismatch");
  }
}

function encryptWithDataKey(plaintext: Buffer, dataKey: Uint8Array, aad: Buffer): {
  ciphertext: Buffer;
  iv: Buffer;
  authTag: Buffer;
} {
  if (dataKey.byteLength !== 32) throw new Error("The data key must contain exactly 32 bytes");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", dataKey, iv);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { ciphertext, iv, authTag: cipher.getAuthTag() };
}

function decryptWithDataKey(
  envelope: Pick<SecretEnvelope, "ciphertext" | "iv" | "authTag">,
  dataKey: Uint8Array,
  aad: Buffer,
): Buffer {
  if (dataKey.byteLength !== 32) throw new Error("The data key must contain exactly 32 bytes");
  const decipher = createDecipheriv("aes-256-gcm", dataKey, Buffer.from(envelope.iv, "base64"));
  decipher.setAAD(aad);
  decipher.setAuthTag(Buffer.from(envelope.authTag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, "base64")), decipher.final()]);
}

function plaintextBuffer(plaintext: string): Buffer {
  const buffer = Buffer.from(plaintext, "utf8");
  if (buffer.length === 0 || buffer.length > MAX_SECRET_BYTES) {
    buffer.fill(0);
    throw new Error(`Secrets must contain between 1 and ${MAX_SECRET_BYTES} UTF-8 bytes`);
  }
  return buffer;
}

export function decodeLocalMasterKey(encoded: string): Buffer {
  let key: Buffer;
  if (/^[a-f0-9]{64}$/i.test(encoded)) key = Buffer.from(encoded, "hex");
  else key = Buffer.from(encoded, "base64");
  if (key.length !== 32) {
    key.fill(0);
    throw new Error("LOCAL_VAULT_MASTER_KEY must encode exactly 32 random bytes");
  }
  return key;
}

/** Local development only. Production construction is rejected by the environment loader. */
export class LocalEnvelopeCipher implements SecretCipher {
  readonly keyId: string;
  readonly #masterKey: Buffer;

  constructor(masterKey: Uint8Array, keyId = "local-development-v1") {
    if (masterKey.byteLength !== 32) throw new Error("The local master key must contain exactly 32 bytes");
    this.#masterKey = Buffer.from(masterKey);
    this.keyId = keyId;
  }

  static fromEncodedKey(encoded: string, keyId?: string): LocalEnvelopeCipher {
    const key = decodeLocalMasterKey(encoded);
    try {
      return new LocalEnvelopeCipher(key, keyId);
    } finally {
      key.fill(0);
    }
  }

  async encrypt(plaintext: string, context: SecretEncryptionContext): Promise<SecretEnvelope> {
    const content = plaintextBuffer(plaintext);
    const dataKey = randomBytes(32);
    try {
      const material = contextMaterial(context);
      const encrypted = encryptWithDataKey(content, dataKey, material.aad);
      const wrapIv = randomBytes(12);
      const wrapper = createCipheriv("aes-256-gcm", this.#masterKey, wrapIv);
      wrapper.setAAD(Buffer.from(`reddone-local-wrap:v1:${material.hash}`, "utf8"));
      const wrappedDataKey = Buffer.concat([wrapper.update(dataKey), wrapper.final()]);

      return SecretEnvelopeSchema.parse({
        schemaVersion: 1,
        algorithm: "AES-256-GCM",
        keyProvider: "local",
        keyId: this.keyId,
        ciphertext: encrypted.ciphertext.toString("base64"),
        wrappedDataKey: wrappedDataKey.toString("base64"),
        iv: encrypted.iv.toString("base64"),
        authTag: encrypted.authTag.toString("base64"),
        wrapIv: wrapIv.toString("base64"),
        wrapAuthTag: wrapper.getAuthTag().toString("base64"),
        contextHash: material.hash,
      });
    } finally {
      content.fill(0);
      dataKey.fill(0);
    }
  }

  async decrypt(envelopeInput: SecretEnvelope, context: SecretEncryptionContext): Promise<string> {
    const envelope = SecretEnvelopeSchema.parse(envelopeInput);
    if (envelope.keyProvider !== "local" || envelope.keyId !== this.keyId || !envelope.wrapIv || !envelope.wrapAuthTag) {
      throw new Error("This cipher cannot decrypt the supplied envelope");
    }
    const material = contextMaterial(context);
    assertContextHash(envelope.contextHash, material.hash);

    const unwrapper = createDecipheriv("aes-256-gcm", this.#masterKey, Buffer.from(envelope.wrapIv, "base64"));
    unwrapper.setAAD(Buffer.from(`reddone-local-wrap:v1:${material.hash}`, "utf8"));
    unwrapper.setAuthTag(Buffer.from(envelope.wrapAuthTag, "base64"));
    const dataKey = Buffer.concat([
      unwrapper.update(Buffer.from(envelope.wrappedDataKey, "base64")),
      unwrapper.final(),
    ]);
    try {
      const plaintext = decryptWithDataKey(envelope, dataKey, material.aad);
      try {
        return plaintext.toString("utf8");
      } finally {
        plaintext.fill(0);
      }
    } finally {
      dataKey.fill(0);
    }
  }

  destroy(): void {
    this.#masterKey.fill(0);
  }
}

/** KMS-backed production envelope encryption. Provider adapters never expose a root key. */
export class KmsEnvelopeCipher implements SecretCipher {
  constructor(
    private readonly provider: KmsDataKeyProvider,
    private readonly keyProvider: "aws-kms" | "gcp-kms" = "aws-kms",
  ) {}

  async encrypt(plaintext: string, context: SecretEncryptionContext): Promise<SecretEnvelope> {
    const content = plaintextBuffer(plaintext);
    const material = contextMaterial(context);
    try {
      const generated = await this.provider.generateDataKey(material.kmsContext);
      const dataKey = Buffer.from(generated.plaintextDataKey);
      generated.plaintextDataKey.fill(0);
      try {
        const encrypted = encryptWithDataKey(content, dataKey, material.aad);
        return SecretEnvelopeSchema.parse({
          schemaVersion: 1,
          algorithm: "AES-256-GCM",
          keyProvider: this.keyProvider,
          keyId: generated.keyId,
          ciphertext: encrypted.ciphertext.toString("base64"),
          wrappedDataKey: Buffer.from(generated.encryptedDataKey).toString("base64"),
          iv: encrypted.iv.toString("base64"),
          authTag: encrypted.authTag.toString("base64"),
          wrapIv: null,
          wrapAuthTag: null,
          contextHash: material.hash,
        });
      } finally {
        dataKey.fill(0);
      }
    } finally {
      content.fill(0);
    }
  }

  async decrypt(envelopeInput: SecretEnvelope, context: SecretEncryptionContext): Promise<string> {
    const envelope = SecretEnvelopeSchema.parse(envelopeInput);
    if (envelope.keyProvider !== this.keyProvider) throw new Error("This cipher cannot decrypt the supplied envelope");
    const material = contextMaterial(context);
    assertContextHash(envelope.contextHash, material.hash);
    const plaintextKey = await this.provider.decryptDataKey(
      Buffer.from(envelope.wrappedDataKey, "base64"),
      material.kmsContext,
      envelope.keyId,
    );
    const dataKey = Buffer.from(plaintextKey);
    try {
      const plaintext = decryptWithDataKey(envelope, dataKey, material.aad);
      try {
        return plaintext.toString("utf8");
      } finally {
        plaintext.fill(0);
      }
    } finally {
      dataKey.fill(0);
    }
  }
}

export function envelopeToPersistence(envelopeInput: SecretEnvelope): SecretVersionPersistence {
  const envelope = SecretEnvelopeSchema.parse(envelopeInput);
  return {
    algorithm: "A256GCM",
    keyProvider: envelope.keyProvider,
    keyId: envelope.keyId,
    ciphertext: Buffer.from(envelope.ciphertext, "base64"),
    wrappedDataKey: Buffer.from(envelope.wrappedDataKey, "base64"),
    iv: Buffer.from(envelope.iv, "base64"),
    authTag: Buffer.from(envelope.authTag, "base64"),
    wrapIv: envelope.wrapIv ? Buffer.from(envelope.wrapIv, "base64") : null,
    wrapAuthTag: envelope.wrapAuthTag ? Buffer.from(envelope.wrapAuthTag, "base64") : null,
    contextHash: envelope.contextHash,
  };
}

export function createSecretCipher(
  configuration: VaultCipherConfiguration,
  kmsProvider?: KmsDataKeyProvider,
): SecretCipher {
  if (configuration.kind === "local") return LocalEnvelopeCipher.fromEncodedKey(configuration.masterKey);
  if (configuration.kind === "aws-kms" || configuration.kind === "gcp-kms") {
    if (!kmsProvider) throw new Error("A KMS data-key provider is required for the production vault");
    return new KmsEnvelopeCipher(kmsProvider, configuration.kind);
  }
  throw new Error("Secret storage is unavailable; configure KMS or a local development master key");
}
