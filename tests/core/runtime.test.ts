import { describe, expect, it } from "vitest";

import {
  EnvironmentConfigurationError,
  getDeploymentMode,
  getRuntimeConfig,
  getVercelIntegrationSlug,
  hashSetupToken,
  isDemoMode,
  recordSetupAttempt,
  verifySetupToken,
} from "@/server";

describe("runtime configuration and owner setup", () => {
  it("starts safely in demo mode without a database", () => {
    const config = getRuntimeConfig({});
    expect(config.mode).toBe("demo");
    expect(config.database).toBeNull();
    expect(config.vault.kind).toBe("unavailable");
  });

  it("gives explicit APP_MODE priority over the legacy demo flag", () => {
    expect(getDeploymentMode({ APP_MODE: "hackathon", DEMO_MODE: "true" })).toBe("hackathon");
    expect(isDemoMode({ APP_MODE: "hackathon", DEMO_MODE: "true" })).toBe(false);
    expect(getDeploymentMode({ APP_MODE: "private", DEMO_MODE: "true" })).toBe("private");
    expect(isDemoMode({ APP_MODE: "private", DEMO_MODE: "true" })).toBe(false);
    expect(getDeploymentMode({ APP_MODE: "public", DEMO_MODE: "true" })).toBe("public");
    expect(isDemoMode({ APP_MODE: "public", DEMO_MODE: "true" })).toBe(false);
    expect(getDeploymentMode({ APP_MODE: "demo", DEMO_MODE: "false" })).toBe("demo");
    expect(isDemoMode({ APP_MODE: "demo", DEMO_MODE: "false" })).toBe(true);
    expect(() => getVercelIntegrationSlug({ VERCEL_INTEGRATION_SLUG: "not/a-slug" })).toThrow(EnvironmentConfigurationError);
  });

  it("requires an explicit mode, database, auth, and GCP KMS configuration in live mode", () => {
    expect(() => getRuntimeConfig({ NODE_ENV: "production" })).toThrow(EnvironmentConfigurationError);

    const liveEnvironment = {
      NODE_ENV: "production",
      APP_MODE: "private",
      DATABASE_URL: "postgresql://user:pass@localhost:5432/reddone",
      BETTER_AUTH_SECRET: "a".repeat(32),
      VERIFICATION_SIGNING_KEY: "v".repeat(32),
      VERIFICATION_SIGNING_KEY_ID: "verification-v1",
      NEXT_PUBLIC_APP_URL: "https://console.example.test",
      PREVIEW_ORIGIN: "https://preview.example.test",
      PREVIEW_SIGNING_KEY: "p".repeat(32),
      KIMI_INPUT_COST_MICROS_PER_MILLION: "1000",
      KIMI_OUTPUT_COST_MICROS_PER_MILLION: "2000",
      GCP_PROJECT_ID: "reddone-hackathon",
      GCP_PROJECT_NUMBER: "123456789012",
      GCP_SERVICE_ACCOUNT_EMAIL: "reddone-runtime@reddone-hackathon.iam.gserviceaccount.com",
      GCP_WORKLOAD_IDENTITY_POOL_ID: "vercel",
      GCP_WORKLOAD_IDENTITY_POOL_PROVIDER_ID: "vercel",
      GCP_KMS_KEY_NAME: "projects/reddone-hackathon/locations/us-central1/keyRings/reddone/cryptoKeys/vault",
      GCP_ARTIFACT_BUCKET: "reddone-artifacts",
      GCP_ARTIFACT_SIGNER_SERVICE_ACCOUNT: "reddone-signer@reddone-hackathon.iam.gserviceaccount.com",
    } as const;
    const config = getRuntimeConfig(liveEnvironment);
    expect(config.mode).toBe("live");
    expect(config.database?.url).toContain("postgresql://");
    expect(config.vault.kind).toBe("gcp-kms");
    expect(config.appUrl).toBe("https://console.example.test");

    let missingAppUrlError: unknown;
    try {
      getRuntimeConfig({ ...liveEnvironment, NODE_ENV: "development", NEXT_PUBLIC_APP_URL: undefined });
    } catch (error) {
      missingAppUrlError = error;
    }
    expect(missingAppUrlError).toBeInstanceOf(EnvironmentConfigurationError);
    expect((missingAppUrlError as EnvironmentConfigurationError).issues).toContain(
      "NEXT_PUBLIC_APP_URL must be explicitly configured outside demo mode",
    );

    const localDevelopment = getRuntimeConfig({
      ...liveEnvironment,
      NODE_ENV: "development",
      NEXT_PUBLIC_APP_URL: "http://localhost:3000/",
      AUTH_TRUSTED_ORIGIN: "http://127.0.0.1:3000/",
    });
    expect(localDevelopment.appUrl).toBe("http://localhost:3000");
    expect(localDevelopment.auth.trustedOrigin).toBe("http://127.0.0.1:3000");

    const localVaultDevelopment = getRuntimeConfig({
      ...liveEnvironment,
      NODE_ENV: "development",
      NEXT_PUBLIC_APP_URL: "http://localhost:3000",
      AUTH_TRUSTED_ORIGIN: "http://localhost:3000",
      LOCAL_VAULT_MASTER_KEY: Buffer.alloc(32, 7).toString("base64"),
      GCP_PROJECT_ID: undefined,
      GCP_PROJECT_NUMBER: undefined,
      GCP_SERVICE_ACCOUNT_EMAIL: undefined,
      GCP_WORKLOAD_IDENTITY_POOL_ID: undefined,
      GCP_WORKLOAD_IDENTITY_POOL_PROVIDER_ID: undefined,
      GCP_KMS_KEY_NAME: undefined,
      GCP_ARTIFACT_BUCKET: undefined,
      GCP_ARTIFACT_SIGNER_SERVICE_ACCOUNT: undefined,
    });
    expect(localVaultDevelopment.vault.kind).toBe("local");
    const derivedLocalVaultDevelopment = getRuntimeConfig({
      ...liveEnvironment,
      NODE_ENV: "development",
      NEXT_PUBLIC_APP_URL: "http://localhost:3000",
      AUTH_TRUSTED_ORIGIN: "http://localhost:3000",
      LOCAL_VAULT_DERIVE_FROM_AUTH: "true",
      GCP_PROJECT_ID: undefined,
      GCP_PROJECT_NUMBER: undefined,
      GCP_SERVICE_ACCOUNT_EMAIL: undefined,
      GCP_WORKLOAD_IDENTITY_POOL_ID: undefined,
      GCP_WORKLOAD_IDENTITY_POOL_PROVIDER_ID: undefined,
      GCP_KMS_KEY_NAME: undefined,
      GCP_ARTIFACT_BUCKET: undefined,
      GCP_ARTIFACT_SIGNER_SERVICE_ACCOUNT: undefined,
    });
    expect(derivedLocalVaultDevelopment.vault.kind).toBe("local");
    if (derivedLocalVaultDevelopment.vault.kind === "local") {
      expect(Buffer.from(derivedLocalVaultDevelopment.vault.masterKey, "base64")).toHaveLength(32);
      expect(derivedLocalVaultDevelopment.vault.masterKey).not.toBe(liveEnvironment.BETTER_AUTH_SECRET);
    }
    expect(getRuntimeConfig({ NODE_ENV: "production", APP_MODE: "demo" }).appUrl).toBe("http://localhost:3000");

    expect(() => getRuntimeConfig({
      ...liveEnvironment,
      NEXT_PUBLIC_APP_URL: "http://console.example.test",
    })).toThrow(EnvironmentConfigurationError);
    expect(() => getRuntimeConfig({
      ...liveEnvironment,
      NEXT_PUBLIC_APP_URL: "https://localhost:3000",
    })).toThrow(EnvironmentConfigurationError);
    expect(() => getRuntimeConfig({
      ...liveEnvironment,
      AUTH_TRUSTED_ORIGIN: "http://auth.example.test",
    })).toThrow(EnvironmentConfigurationError);
    expect(() => getRuntimeConfig({
      ...liveEnvironment,
      AUTH_TRUSTED_ORIGIN: "https://localhost:3000",
    })).toThrow(EnvironmentConfigurationError);
    expect(() => getRuntimeConfig({
      ...liveEnvironment,
      AUTH_TRUSTED_ORIGIN: "https://auth.example.test/path",
    })).toThrow(EnvironmentConfigurationError);

    const normalizedOrigins = getRuntimeConfig({
      ...liveEnvironment,
      NEXT_PUBLIC_APP_URL: "https://console.example.test/",
      AUTH_TRUSTED_ORIGIN: "https://auth.example.test/",
    });
    expect(normalizedOrigins.appUrl).toBe("https://console.example.test");
    expect(normalizedOrigins.auth.trustedOrigin).toBe("https://auth.example.test");

    expect(() => getRuntimeConfig({ ...liveEnvironment, APP_MODE: "public" })).toThrow(EnvironmentConfigurationError);
    const publicConfig = getRuntimeConfig({
      ...liveEnvironment,
      APP_MODE: "public",
      AUTH_EMAIL_DELIVERY_MODE: "webhook",
      AUTH_EMAIL_FROM: "ReDDone <no-reply@example.test>",
      AUTH_EMAIL_WEBHOOK_URL: "https://email.example.test/send",
      AUTH_EMAIL_WEBHOOK_TOKEN: "e".repeat(32),
    });
    expect(publicConfig.deploymentMode).toBe("public");
    expect(publicConfig.auth.emailDelivery.kind).toBe("webhook");
    expect(() => getRuntimeConfig({ DEMO_MODE: "0" })).toThrow(EnvironmentConfigurationError);
  });

  it("requires an HTTPS cookie-less preview origin when live preview is configured", () => {
    const live = {
      APP_MODE: "private",
      DATABASE_URL: "postgresql://user:pass@localhost:5432/reddone",
      BETTER_AUTH_SECRET: "a".repeat(32),
      VERIFICATION_SIGNING_KEY: "v".repeat(32),
      VERIFICATION_SIGNING_KEY_ID: "verification-v1",
      KIMI_INPUT_COST_MICROS_PER_MILLION: "1000",
      KIMI_OUTPUT_COST_MICROS_PER_MILLION: "2000",
      GCP_PROJECT_ID: "reddone-hackathon",
      GCP_PROJECT_NUMBER: "123456789012",
      GCP_SERVICE_ACCOUNT_EMAIL: "reddone-runtime@reddone-hackathon.iam.gserviceaccount.com",
      GCP_WORKLOAD_IDENTITY_POOL_ID: "vercel",
      GCP_WORKLOAD_IDENTITY_POOL_PROVIDER_ID: "vercel",
      GCP_KMS_KEY_NAME: "projects/reddone-hackathon/locations/us-central1/keyRings/reddone/cryptoKeys/vault",
      GCP_ARTIFACT_BUCKET: "reddone-artifacts",
      GCP_ARTIFACT_SIGNER_SERVICE_ACCOUNT: "reddone-signer@reddone-hackathon.iam.gserviceaccount.com",
      NEXT_PUBLIC_APP_URL: "https://console.example.test",
      PREVIEW_SIGNING_KEY: "p".repeat(32),
    };
    expect(() => getRuntimeConfig({ ...live, PREVIEW_ORIGIN: "http://preview.example.test" })).toThrow(EnvironmentConfigurationError);
    expect(() => getRuntimeConfig({ ...live, PREVIEW_ORIGIN: "https://console.example.test" })).toThrow(EnvironmentConfigurationError);
    expect(getRuntimeConfig({ ...live, PREVIEW_ORIGIN: "https://preview.example.test" }).preview).toEqual({
      origin: "https://preview.example.test",
      signingKeyConfigured: true,
    });
    let duplicateServiceAccountError: unknown;
    try {
      getRuntimeConfig({
        ...live,
        PREVIEW_ORIGIN: "https://preview.example.test",
        GCP_ARTIFACT_SIGNER_SERVICE_ACCOUNT: live.GCP_SERVICE_ACCOUNT_EMAIL,
      });
    } catch (error) {
      duplicateServiceAccountError = error;
    }
    expect(duplicateServiceAccountError).toBeInstanceOf(EnvironmentConfigurationError);
    expect((duplicateServiceAccountError as EnvironmentConfigurationError).issues).toContain(
      "GCP runtime and artifact signer service accounts must be distinct",
    );
    expect(() => getRuntimeConfig({ ...live, PREVIEW_ORIGIN: "https://preview.example.test", KIMI_OUTPUT_COST_MICROS_PER_MILLION: "0" })).toThrow(EnvironmentConfigurationError);
  });

  it("refuses the local vault key in production", () => {
    expect(() =>
      getRuntimeConfig({
        NODE_ENV: "production",
        DEMO_MODE: "true",
        LOCAL_VAULT_MASTER_KEY: Buffer.alloc(32).toString("base64"),
      }),
    ).toThrow(/safely/i);
  });

  it("hashes high-entropy setup tokens and rate-limits failed attempts", () => {
    const token = "a-random-owner-setup-token-that-is-long-enough";
    const hash = hashSetupToken(token);
    expect(hash).toHaveLength(64);
    expect(verifySetupToken(token, hash)).toBe(true);
    expect(verifySetupToken(`${token}-wrong`, hash)).toBe(false);

    let state = { failedAttempts: 0, lockedUntil: null as Date | null };
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const result = recordSetupAttempt(state, false, new Date("2026-07-11T00:00:00.000Z"));
      state = { failedAttempts: result.failedAttempts, lockedUntil: result.lockedUntil };
    }
    expect(state.failedAttempts).toBe(5);
    expect(state.lockedUntil).not.toBeNull();
  });
});
