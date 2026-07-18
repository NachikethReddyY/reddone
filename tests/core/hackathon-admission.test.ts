import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  HACKATHON_ADMISSION_COOKIE,
  hasHackathonAdmission,
  isHackathonGitHubOAuthRequest,
  issueHackathonAdmission,
  verifyHackathonAdmission,
  verifyHackathonRegistrationCode,
} from "@/server/hackathon-admission";

const registrationCode = "r".repeat(48);

const requiredHackathonEnvironment: Record<string, string> = {
  NODE_ENV: "test",
  APP_MODE: "hackathon",
  NEXT_PUBLIC_APP_URL: "https://console.example.test",
  DATABASE_URL: "postgresql://reddone:password@localhost:5432/reddone",
  BETTER_AUTH_SECRET: "a".repeat(32),
  VERIFICATION_SIGNING_KEY: "b".repeat(32),
  VERIFICATION_SIGNING_KEY_ID: "verification-v1",
  PREVIEW_ORIGIN: "https://preview.example.test",
  PREVIEW_SIGNING_KEY: "c".repeat(32),
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
  GITHUB_AUTH_CLIENT_ID: "github-client-id",
  GITHUB_AUTH_CLIENT_SECRET: "github-client-secret",
  HACKATHON_REGISTRATION_CODE: registrationCode,
  HACKATHON_REGISTRATION_PEPPER: "p".repeat(48),
};

describe("hackathon admission", () => {
  beforeEach(() => {
    for (const [name, value] of Object.entries(requiredHackathonEnvironment)) vi.stubEnv(name, value);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("accepts only the configured registration code and issues a short-lived signed admission", () => {
    expect(verifyHackathonRegistrationCode(registrationCode)).toBe(true);
    expect(verifyHackathonRegistrationCode("x".repeat(48))).toBe(false);

    const issuedAt = Date.now();
    const admission = issueHackathonAdmission(issuedAt);
    const request = new Request("https://console.example.test/api/auth/sign-in/social", {
      headers: { cookie: `${HACKATHON_ADMISSION_COOKIE}=${encodeURIComponent(admission)}` },
    });

    expect(hasHackathonAdmission(request)).toBe(true);
    expect(verifyHackathonAdmission(admission, issuedAt + 10 * 60_000 - 1)).toBe(true);
    expect(verifyHackathonAdmission(admission, issuedAt + 10 * 60_000)).toBe(false);
  });

  it("does not accept an admission outside hackathon mode", () => {
    const admission = issueHackathonAdmission();
    vi.stubEnv("APP_MODE", "private");

    expect(verifyHackathonAdmission(admission)).toBe(false);
  });

  it("targets only the Better Auth GitHub OAuth endpoints", () => {
    expect(isHackathonGitHubOAuthRequest({ url: "https://console.example.test/api/auth/sign-in/social" })).toBe(true);
    expect(isHackathonGitHubOAuthRequest({ url: "https://console.example.test/api/auth/callback/github" })).toBe(true);
    expect(isHackathonGitHubOAuthRequest({ url: "https://console.example.test/api/auth/get-session" })).toBe(false);
    expect(isHackathonGitHubOAuthRequest({ url: "https://console.example.test/api/integrations/github/start" })).toBe(false);
  });
});
