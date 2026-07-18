import { defineConfig } from "@playwright/test";

const demoPort = 3210;
const publicPort = 3211;
const demoBaseUrlOverride = process.env.PLAYWRIGHT_DEMO_BASE_URL;
const publicBaseUrlOverride = process.env.PLAYWRIGHT_PUBLIC_BASE_URL;
const demoBaseURL = new URL(demoBaseUrlOverride ?? `http://127.0.0.1:${demoPort}`).origin;
const publicBaseURL = new URL(publicBaseUrlOverride ?? `http://127.0.0.1:${publicPort}`).origin;

const publicServerEnv = {
  NODE_ENV: "production",
  APP_MODE: "public",
  NEXT_PUBLIC_APP_URL: "https://public.control-plane.reddone.test",
  AUTH_TRUSTED_ORIGIN: "https://public.control-plane.reddone.test",
  DATABASE_URL: "postgresql://reddone:reddone@database.reddone.test:5432/reddone",
  DIRECT_URL: "postgresql://reddone:reddone@database.reddone.test:5432/reddone",
  BETTER_AUTH_SECRET: "playwright-auth-signing-key-aaaaaaaaaaaaaaaaaaaaaaaa",
  VERIFICATION_SIGNING_KEY: "playwright-verification-key-bbbbbbbbbbbbbbbbbbbbbbbb",
  VERIFICATION_SIGNING_KEY_ID: "playwright-verification-hmac-v1",
  AUTH_EMAIL_DELIVERY_MODE: "webhook",
  AUTH_EMAIL_FROM: "ReDDone Playwright <no-reply@reddone.test>",
  AUTH_EMAIL_WEBHOOK_URL: "https://email-webhook.reddone.test/auth",
  AUTH_EMAIL_WEBHOOK_TOKEN: "playwright-email-webhook-token-cccccccccccccccccccc",
  PREVIEW_ORIGIN: "https://preview.control-plane.reddone.test",
  PREVIEW_SIGNING_KEY: "playwright-preview-signing-key-dddddddddddddddddddd",
  GCP_PROJECT_ID: "reddone-playwright",
  GCP_PROJECT_NUMBER: "123456789012",
  GCP_SERVICE_ACCOUNT_EMAIL: "runtime@reddone-playwright.iam.gserviceaccount.com",
  GCP_WORKLOAD_IDENTITY_POOL_ID: "playwright-pool",
  GCP_WORKLOAD_IDENTITY_POOL_PROVIDER_ID: "playwright-provider",
  GCP_KMS_KEY_NAME: "projects/reddone-playwright/locations/us-central1/keyRings/reddone/cryptoKeys/vault",
  GCP_ARTIFACT_BUCKET: "reddone-playwright-artifacts",
  GCP_ARTIFACT_SIGNER_SERVICE_ACCOUNT: "artifact-signer@reddone-playwright.iam.gserviceaccount.com",
  KIMI_INPUT_COST_MICROS_PER_MILLION: "1000000",
  KIMI_OUTPUT_COST_MICROS_PER_MILLION: "2000000",
  BILLING_ENABLED: "false",
  BILLING_CHECKOUT_ENABLED: "false",
  BILLING_PORTAL_ENABLED: "false",
  CUSTOMER_CREDITS_ENFORCED: "false",
} as const;

const webServer = [
  ...(demoBaseUrlOverride
    ? []
    : [{
        command: `pnpm exec next start -p ${demoPort}`,
        url: demoBaseURL,
        reuseExistingServer: false,
        timeout: 120_000,
        env: {
          NODE_ENV: "production",
          APP_MODE: "demo",
          NEXT_PUBLIC_APP_URL: demoBaseURL,
          AUTH_TRUSTED_ORIGIN: demoBaseURL,
        },
      }]),
  ...(publicBaseUrlOverride
    ? []
    : [{
        command: `pnpm exec next start -p ${publicPort}`,
        url: publicBaseURL,
        reuseExistingServer: false,
        timeout: 120_000,
        env: publicServerEnv,
      }]),
];

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  ...(process.env.CI ? { workers: 1 } : {}),
  reporter: "list",
  timeout: 45_000,
  expect: { timeout: 10_000 },
  use: {
    browserName: "chromium",
    navigationTimeout: 20_000,
    actionTimeout: 10_000,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer,
  projects: [
    {
      name: "demo",
      use: { baseURL: demoBaseURL },
    },
    {
      name: "public",
      use: { baseURL: publicBaseURL },
    },
  ],
});
