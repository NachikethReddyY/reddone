import { randomBytes } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  envelopeToPersistence,
  GcpKmsDataKeyProvider,
  KmsEnvelopeCipher,
  LocalEnvelopeCipher,
  type KmsDataKeyProvider,
  type SecretEncryptionContext,
} from "@/server/security";

const context: SecretEncryptionContext = {
  workspaceId: "workspace-1",
  provider: "kimi",
  secretName: "api-key",
  version: 1,
  projectId: null,
};

describe("secret envelope encryption", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("round-trips locally without placing plaintext in the envelope", async () => {
    const cipher = new LocalEnvelopeCipher(randomBytes(32));
    const plaintext = "secret-value-that-must-never-be-persisted";
    const first = await cipher.encrypt(plaintext, context);
    const second = await cipher.encrypt(plaintext, context);

    expect(JSON.stringify(first)).not.toContain(plaintext);
    expect(first.ciphertext).not.toBe(second.ciphertext);
    await expect(cipher.decrypt(first, context)).resolves.toBe(plaintext);

    const persistence = envelopeToPersistence(first);
    expect(persistence.ciphertext.toString("utf8")).not.toContain(plaintext);
    expect(persistence.contextHash).toHaveLength(64);
    cipher.destroy();
  });

  it("binds an envelope to the complete authenticated context", async () => {
    const cipher = new LocalEnvelopeCipher(randomBytes(32));
    const envelope = await cipher.encrypt("context-bound-secret", context);

    await expect(cipher.decrypt(envelope, { ...context, version: 2 })).rejects.toThrow(/context/i);
    await expect(cipher.decrypt(envelope, { ...context, workspaceId: "workspace-2" })).rejects.toThrow(/context/i);
    cipher.destroy();
  });

  it("detects ciphertext tampering", async () => {
    const cipher = new LocalEnvelopeCipher(randomBytes(32));
    const envelope = await cipher.encrypt("tamper-resistant-secret", context);
    const bytes = Buffer.from(envelope.ciphertext, "base64");
    bytes[0] = (bytes[0] ?? 0) ^ 1;

    await expect(cipher.decrypt({ ...envelope, ciphertext: bytes.toString("base64") }, context)).rejects.toThrow();
    cipher.destroy();
  });

  it("keeps KMS key generation behind an injectable production adapter", async () => {
    const dataKey = randomBytes(32);
    const seenContexts: Readonly<Record<string, string>>[] = [];
    const provider: KmsDataKeyProvider = {
      async generateDataKey(encryptionContext) {
        seenContexts.push(encryptionContext);
        return {
          plaintextDataKey: Buffer.from(dataKey),
          encryptedDataKey: Buffer.from("opaque-kms-ciphertext"),
          keyId: "arn:aws:kms:example:key/test",
        };
      },
      async decryptDataKey(_encrypted, encryptionContext) {
        seenContexts.push(encryptionContext);
        return Buffer.from(dataKey);
      },
    };
    const cipher = new KmsEnvelopeCipher(provider);
    const envelope = await cipher.encrypt("kms-protected", context);

    expect(envelope.keyProvider).toBe("aws-kms");
    await expect(cipher.decrypt(envelope, context)).resolves.toBe("kms-protected");
    expect(seenContexts[0]).toEqual(seenContexts[1]);
    dataKey.fill(0);
  });

  it("uses short-lived Google credentials and binds the complete context when wrapping data keys", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ciphertext: Buffer.alloc(32, 3).toString("base64") }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ plaintext: Buffer.alloc(32, 7).toString("base64") }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const provider = new GcpKmsDataKeyProvider({
      keyName: "projects/reddone/locations/us-central1/keyRings/reddone/cryptoKeys/vault",
      authClient: { getAccessToken: async () => ({ token: "short-lived-token" }) } as never,
    });
    const gcpContext = {
      workspaceId: "workspace-1",
      provider: "kimi",
      secretName: "api-key",
      version: "1",
      projectId: "control-plane",
      contextHash: "a".repeat(64),
    };

    const generated = await provider.generateDataKey(gcpContext);
    expect(generated.keyId).toContain("cryptoKeys/vault");
    expect(generated.plaintextDataKey).toHaveLength(32);
    await expect(provider.decryptDataKey(Buffer.alloc(32, 3), gcpContext, generated.keyId)).resolves.toEqual(Buffer.alloc(32, 7));
    const firstRequest = fetchMock.mock.calls[0];
    expect(firstRequest?.[0]).toContain(":encrypt");
    expect(firstRequest?.[1]).toMatchObject({ headers: { authorization: "Bearer short-lived-token" } });
    const requestBody = JSON.parse(String(firstRequest?.[1]?.body)) as { additionalAuthenticatedData: string };
    expect(requestBody.additionalAuthenticatedData).toBeTruthy();
  });
});
