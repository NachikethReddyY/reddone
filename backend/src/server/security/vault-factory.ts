import "server-only";


import { getRuntimeConfig } from "../env";
import { createGcpWorkloadIdentityClient } from "./gcp-auth";
import { GcpKmsDataKeyProvider } from "./gcp-kms-provider";
import { createSecretCipher, type SecretCipher } from "./encryption";

let localCipher: SecretCipher | undefined;

export async function getVaultCipher(): Promise<SecretCipher> {
  const config = getRuntimeConfig();
  if (config.vault.kind === "local") {
    localCipher ??= createSecretCipher(config.vault);
    return localCipher;
  }
  if (config.vault.kind !== "gcp-kms") {
    throw new Error("Secret storage is unavailable. Configure the KMS/OIDC vault.");
  }
  const auth = createGcpWorkloadIdentityClient(config.vault);
  return createSecretCipher(
    { kind: "gcp-kms" },
    new GcpKmsDataKeyProvider({ keyName: config.vault.keyName, authClient: auth }),
  );
}
