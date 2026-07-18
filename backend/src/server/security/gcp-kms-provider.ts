import { randomBytes } from "node:crypto";

import type { AuthClient } from "google-auth-library";
import type { KmsDataKeyProvider } from "./encryption";

export interface GcpKmsDataKeyProviderOptions {
  keyName: string;
  authClient: Pick<AuthClient, "getAccessToken">;
}

function additionalAuthenticatedData(context: Readonly<Record<string, string>>): Buffer {
  return Buffer.from(JSON.stringify(Object.entries(context).sort(([left], [right]) => left.localeCompare(right))), "utf8");
}

/** Cloud KMS has no GenerateDataKey operation, so it wraps a locally generated AES-256 data key. */
export class GcpKmsDataKeyProvider implements KmsDataKeyProvider {
  readonly #keyName: string;
  readonly #authClient: Pick<AuthClient, "getAccessToken">;

  constructor(options: GcpKmsDataKeyProviderOptions) {
    this.#keyName = options.keyName;
    this.#authClient = options.authClient;
  }

  async #request(action: "encrypt" | "decrypt", body: Record<string, string>) {
    const accessTokenResponse = await this.#authClient.getAccessToken();
    const accessToken = typeof accessTokenResponse === "string" ? accessTokenResponse : accessTokenResponse?.token;
    if (!accessToken) throw new Error("Google workload identity did not return an access token");
    const response = await fetch(`https://cloudkms.googleapis.com/v1/${this.#keyName}:${action}`, {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`Cloud KMS ${action} failed (${response.status})`);
    const payload: unknown = await response.json();
    if (typeof payload !== "object" || payload === null || typeof (payload as Record<string, unknown>).plaintext !== "string" && typeof (payload as Record<string, unknown>).ciphertext !== "string") {
      throw new Error("Cloud KMS returned an invalid response");
    }
    return payload as { plaintext?: string; ciphertext?: string };
  }

  async generateDataKey(context: Readonly<Record<string, string>>): Promise<{
    plaintextDataKey: Uint8Array;
    encryptedDataKey: Uint8Array;
    keyId: string;
  }> {
    const plaintextDataKey = randomBytes(32);
    try {
      const result = await this.#request("encrypt", {
        plaintext: plaintextDataKey.toString("base64"),
        additionalAuthenticatedData: additionalAuthenticatedData(context).toString("base64"),
      });
      if (!result.ciphertext) throw new Error("Cloud KMS did not return an encrypted data key");
      return {
        plaintextDataKey,
        encryptedDataKey: Buffer.from(result.ciphertext, "base64"),
        keyId: this.#keyName,
      };
    } catch (error) {
      plaintextDataKey.fill(0);
      throw error;
    }
  }

  async decryptDataKey(
    encryptedDataKey: Uint8Array,
    context: Readonly<Record<string, string>>,
    keyId: string,
  ): Promise<Uint8Array> {
    if (keyId !== this.#keyName) throw new Error("Cloud KMS key identifier mismatch");
    const result = await this.#request("decrypt", {
      ciphertext: Buffer.from(encryptedDataKey).toString("base64"),
      additionalAuthenticatedData: additionalAuthenticatedData(context).toString("base64"),
    });
    const plaintext = result.plaintext ? Buffer.from(result.plaintext, "base64") : null;
    if (!plaintext || plaintext.byteLength !== 32) throw new Error("Cloud KMS returned an invalid plaintext data key");
    return plaintext;
  }
}
