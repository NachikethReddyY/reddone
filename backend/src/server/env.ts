import { createHash } from "node:crypto";

import { z } from "zod";

import { DEFAULT_AIAND_BUILDER_MODEL, DEFAULT_AIAND_RESEARCH_MODEL } from "@/integrations/inference-config";

import { AppError } from "./errors";

const emptyToUndefined = (value: unknown): unknown => (value === "" ? undefined : value);
const hasProtocol = (value: string, protocols: readonly string[]): boolean => {
  try {
    return protocols.includes(new URL(value).protocol);
  } catch {
    return false;
  }
};
const OptionalString = z.preprocess(emptyToUndefined, z.string().optional());
const OptionalPort = z.preprocess(
  emptyToUndefined,
  z.string().regex(/^\d{1,5}$/, "Expected a TCP port").refine((value) => Number(value) >= 1 && Number(value) <= 65_535, {
    message: "Expected a TCP port between 1 and 65535",
  }).optional(),
);
const HttpUrl = z.string().url().refine((value) => hasProtocol(value, ["http:", "https:"]), {
  message: "Expected an HTTP(S) URL",
});
const OptionalUrl = z.preprocess(emptyToUndefined, HttpUrl.optional());
const HttpOrigin = HttpUrl.refine((value) => {
  const url = new URL(value);
  return !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash;
}, { message: "Expected an HTTP(S) origin without a path, query, or credentials" });
const OptionalOrigin = z.preprocess(emptyToUndefined, HttpOrigin.optional());
const isLocalHostname = (hostname: string): boolean => {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost"
    || normalized.endsWith(".localhost")
    || normalized === "0.0.0.0"
    || normalized === "::1"
    || /^127(?:\.\d{1,3}){3}$/.test(normalized);
};
const OptionalDatabaseUrl = z.preprocess(
  emptyToUndefined,
  z
    .string()
    .refine((value) => hasProtocol(value, ["postgres:", "postgresql:"]), {
      message: "Expected a PostgreSQL connection URL",
    })
    .optional(),
);
const OptionalHash = z.preprocess(
  emptyToUndefined,
  z.string().regex(/^[a-f0-9]{64}$/i, "Expected a SHA-256 hash").optional(),
);
const OptionalSecret = z.preprocess(emptyToUndefined, z.string().min(32).optional());
const OptionalCostRate = z.preprocess(emptyToUndefined, z.string().regex(/^\d{1,15}$/).optional());
const OptionalVercelIntegrationSlug = z.preprocess(
  emptyToUndefined,
  z.string().trim().regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/).optional(),
);
const OptionalVercelTeamId = z.preprocess(emptyToUndefined, z.string().regex(/^team_[A-Za-z0-9_-]+$/).optional());
const OptionalStripeKey = z.preprocess(
  emptyToUndefined,
  z.string().regex(/^(?:rk|sk)_(?:test|live)_[A-Za-z0-9_]+$/, "Expected a Stripe restricted or secret key").optional(),
);
const OptionalStripeWebhookSecret = z.preprocess(
  emptyToUndefined,
  z.string().regex(/^whsec_[A-Za-z0-9_]+$/, "Expected a Stripe webhook signing secret").optional(),
);
const OptionalStripePortalConfigurationId = z.preprocess(
  emptyToUndefined,
  z.string().regex(/^bpc_[A-Za-z0-9]+$/, "Expected a Stripe Portal configuration ID").optional(),
);
const OptionalStripePriceId = z.preprocess(
  emptyToUndefined,
  z.string().regex(/^price_[A-Za-z0-9]+$/, "Expected a Stripe Price ID").optional(),
);
const EnvBoolean = z
  .union([z.boolean(), z.enum(["true", "false"])])
  .transform((value) => value === true || value === "true");

export const RuntimeEnvSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    NEXT_PUBLIC_APP_URL: HttpOrigin.default("http://localhost:3000"),
    DATABASE_URL: OptionalDatabaseUrl,
    DIRECT_URL: OptionalDatabaseUrl,
    BETTER_AUTH_SECRET: OptionalSecret,
    VERIFICATION_SIGNING_KEY: OptionalSecret,
    VERIFICATION_SIGNING_KEY_ID: OptionalString,
    SETUP_TOKEN_HASH: OptionalHash,
    WORKSPACE_TIMEZONE: z.string().trim().min(1).max(100).default("Asia/Singapore"),
    /** Required in production. Legacy DEMO_MODE is accepted only outside production. */
    APP_MODE: z.enum(["demo", "private", "hackathon", "public"]).optional(),
    DEMO_MODE: EnvBoolean.optional(),
    AUTH_EMAIL_DELIVERY_MODE: z.enum(["log", "webhook"]).optional(),
    AUTH_EMAIL_FROM: OptionalString,
    AUTH_EMAIL_WEBHOOK_URL: OptionalUrl,
    AUTH_EMAIL_WEBHOOK_TOKEN: OptionalSecret,
    GCP_PROJECT_ID: OptionalString,
    GCP_PROJECT_NUMBER: OptionalString,
    GCP_SERVICE_ACCOUNT_EMAIL: OptionalString,
    GCP_WORKLOAD_IDENTITY_POOL_ID: OptionalString,
    GCP_WORKLOAD_IDENTITY_POOL_PROVIDER_ID: OptionalString,
    GCP_KMS_KEY_NAME: OptionalString,
    GCP_ARTIFACT_BUCKET: OptionalString,
    GCP_ARTIFACT_SIGNER_SERVICE_ACCOUNT: OptionalString,
    GITHUB_AUTH_CLIENT_ID: OptionalString,
    GITHUB_AUTH_CLIENT_SECRET: OptionalString,
    HACKATHON_REGISTRATION_CODE: OptionalSecret,
    HACKATHON_REGISTRATION_PEPPER: OptionalSecret,
    OWNER_ACCESS_CODE_PEPPER: OptionalSecret,
    LOCAL_VAULT_MASTER_KEY: OptionalString,
    LOCAL_VAULT_DERIVE_FROM_AUTH: EnvBoolean.default(false),
    GITHUB_APP_ID: OptionalString,
    GITHUB_APP_PRIVATE_KEY: OptionalString,
    GITHUB_CLIENT_ID: OptionalString,
    GITHUB_CLIENT_SECRET: OptionalString,
    GITHUB_WEBHOOK_SECRET: OptionalString,
    VERCEL_INTEGRATION_CLIENT_ID: OptionalString,
    VERCEL_INTEGRATION_CLIENT_SECRET: OptionalString,
    VERCEL_INTEGRATION_SLUG: OptionalVercelIntegrationSlug,
    VERCEL_WEBHOOK_SECRET: OptionalString,
    VERCEL_ALLOWED_TEAM_ID: OptionalVercelTeamId,
    CRON_SECRET: OptionalString,
    BILLING_ENABLED: EnvBoolean.default(false),
    BILLING_CHECKOUT_ENABLED: EnvBoolean.default(false),
    BILLING_PORTAL_ENABLED: EnvBoolean.default(false),
    CUSTOMER_CREDITS_ENFORCED: EnvBoolean.default(false),
    STRIPE_MODE: z.enum(["test", "live"]).default("test"),
    STRIPE_SECRET_KEY: OptionalStripeKey,
    STRIPE_WEBHOOK_SECRET: OptionalStripeWebhookSecret,
    STRIPE_PORTAL_CONFIGURATION_ID: OptionalStripePortalConfigurationId,
    STRIPE_PRICE_PLAN_STARTER_SGD_V1: OptionalStripePriceId,
    STRIPE_PRICE_PLAN_BUILDER_SGD_V1: OptionalStripePriceId,
    STRIPE_PRICE_PLAN_SCALE_SGD_V1: OptionalStripePriceId,
    STRIPE_PRICE_PACK_100_SGD_V1: OptionalStripePriceId,
    STRIPE_PRICE_PACK_300_SGD_V1: OptionalStripePriceId,
    STRIPE_PRICE_PACK_1000_SGD_V1: OptionalStripePriceId,
    PREVIEW_ORIGIN: OptionalOrigin,
    PREVIEW_SIGNING_KEY: OptionalSecret,
    AIAND_API_KEY: OptionalString,
    AIAND_BASE_URL: OptionalUrl,
    AIAND_RESEARCH_MODEL: OptionalString,
    AIAND_BUILDER_MODEL: OptionalString,
    /** Compatibility-only settings for existing direct Kimi/Moonshot installations. */
    KIMI_API_KEY: OptionalString,
    MOONSHOT_API_KEY: OptionalString,
    KIMI_BASE_URL: OptionalUrl,
    KIMI_RESEARCH_MODEL: OptionalString,
    KIMI_BUILDER_MODEL: OptionalString,
    KIMI_INPUT_COST_MICROS_PER_MILLION: OptionalCostRate,
    KIMI_OUTPUT_COST_MICROS_PER_MILLION: OptionalCostRate,
    DAYTONA_API_KEY: OptionalString,
    DAYTONA_AGENT_SNAPSHOT: OptionalString,
    PROJECT_WORKSPACE_ENABLED: EnvBoolean.default(false),
    PROJECT_CONVERSATIONS_ENABLED: EnvBoolean.default(false),
    PROJECT_CONVERSATION_AGENT_ENABLED: EnvBoolean.default(false),
    PROJECT_CONVERSATION_MUTATIONS_ENABLED: EnvBoolean.default(false),
    PROJECT_CONVERSATION_AUTOPILOT_ENABLED: EnvBoolean.default(false),
    PROJECT_SECRET_IDEMPOTENCY_KEY: OptionalSecret,
    REDDIT_APPROVAL_REFERENCE: OptionalString,
    OXYLABS_ENDPOINT: OptionalString,
    OXYLABS_PORT: OptionalPort,
    OXYLABS_USERNAME: OptionalString,
    OXYLABS_PASSWORD: OptionalString,
    OXYLABS_AUTHORIZATION_REFERENCE: OptionalString,
    AUTH_TRUSTED_ORIGIN: OptionalOrigin,
  })
  .passthrough();

export interface RuntimeConfig {
  environment: "development" | "test" | "production";
  mode: "demo" | "live";
  deploymentMode: "demo" | "private" | "hackathon" | "public";
  appUrl: string;
  timeZone: string;
  database: null | { url: string; directUrl: string | null };
  auth: {
    secret: string | null;
    setupTokenHash: string | null;
    trustedOrigin: string;
    githubClientId: string | null;
    githubClientSecret: string | null;
    registrationCode: string | null;
    registrationPepper: string | null;
    ownerAccessCodePepper: string | null;
    emailDelivery:
      | { kind: "log" }
      | { kind: "webhook"; endpoint: string; token: string; from: string }
      | { kind: "unavailable" };
  };
  vault:
    | {
      kind: "gcp-kms";
      projectId: string;
      projectNumber: string;
      keyName: string;
      artifactBucket: string;
      serviceAccountEmail: string;
      workloadIdentityPoolId: string;
      workloadIdentityPoolProviderId: string;
      artifactSignerServiceAccount: string;
    }
    | { kind: "local"; masterKey: string }
    | { kind: "unavailable" };
  providers: {
    kimiResearchModel: string;
    kimiBuilderModel: string;
    oxylabsConfigured: boolean;
  };
  preview: {
    origin: string | null;
    signingKeyConfigured: boolean;
  };
  billing: {
    enabled: boolean;
    checkoutEnabled: boolean;
    portalEnabled: boolean;
    creditsEnforced: boolean;
    stripeMode: "test" | "live";
    secretKey: string | null;
    webhookSecret: string | null;
    portalConfigurationId: string | null;
    priceIds: {
      planStarterSgdV1: string | null;
      planBuilderSgdV1: string | null;
      planScaleSgdV1: string | null;
      pack100SgdV1: string | null;
      pack300SgdV1: string | null;
      pack1000SgdV1: string | null;
    };
  };
}

export class EnvironmentConfigurationError extends AppError {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super("internal_error", "The server environment is not configured safely", {
      safeDetails: { issueCount: issues.length },
    });
    this.name = "EnvironmentConfigurationError";
    this.issues = issues;
  }
}

/** Resolves the security posture without lazily accepting a missing production mode. */
export function getDeploymentMode(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): "demo" | "private" | "hackathon" | "public" {
  const parsed = RuntimeEnvSchema.safeParse(environment);
  if (!parsed.success) {
    throw new EnvironmentConfigurationError(parsed.error.issues.map((issue) => `${issue.path.join(".") || "environment"}: ${issue.message}`));
  }
  if (parsed.data.APP_MODE) return parsed.data.APP_MODE;
  if (parsed.data.NODE_ENV === "production") {
    throw new EnvironmentConfigurationError(["APP_MODE must be explicitly set in production"]);
  }
  return parsed.data.DEMO_MODE === false ? "private" : "demo";
}

export function getRuntimeConfig(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): RuntimeConfig {
  const parsed = RuntimeEnvSchema.safeParse(environment);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join(".") || "environment"}: ${issue.message}`);
    throw new EnvironmentConfigurationError(issues);
  }

  const env = parsed.data;
  const issues: string[] = [];
  const deploymentMode = getDeploymentMode(environment);
  const mode = deploymentMode === "demo" ? "demo" : "live";
  const appUrlExplicitlyConfigured = typeof environment.NEXT_PUBLIC_APP_URL === "string"
    && environment.NEXT_PUBLIC_APP_URL.trim().length > 0;
  const appUrl = new URL(env.NEXT_PUBLIC_APP_URL).origin;
  const trustedOrigin = new URL(env.AUTH_TRUSTED_ORIGIN ?? appUrl).origin;

  if (mode === "live" && !appUrlExplicitlyConfigured) {
    issues.push("NEXT_PUBLIC_APP_URL must be explicitly configured outside demo mode");
  }
  if (mode === "live" && env.NODE_ENV === "production") {
    const productionOrigins = [
      ["NEXT_PUBLIC_APP_URL", appUrlExplicitlyConfigured ? appUrl : null],
      ["AUTH_TRUSTED_ORIGIN", env.AUTH_TRUSTED_ORIGIN ? trustedOrigin : null],
    ] as const;
    for (const [name, value] of productionOrigins) {
      if (!value) continue;
      const origin = new URL(value);
      if (origin.protocol !== "https:") issues.push(`${name} must use HTTPS in production live mode`);
      if (isLocalHostname(origin.hostname)) issues.push(`${name} must not use a local hostname in production live mode`);
    }
  }

  if (mode === "live" && !env.DATABASE_URL) issues.push("DATABASE_URL is required outside demo mode");
  if (mode === "live" && !env.BETTER_AUTH_SECRET) issues.push("BETTER_AUTH_SECRET is required outside demo mode");
  if (deploymentMode === "hackathon" && (!env.GITHUB_AUTH_CLIENT_ID || !env.GITHUB_AUTH_CLIENT_SECRET)) {
    issues.push("GITHUB_AUTH_CLIENT_ID and GITHUB_AUTH_CLIENT_SECRET are required in hackathon mode");
  }
  if (deploymentMode === "hackathon" && (!env.HACKATHON_REGISTRATION_CODE || !env.HACKATHON_REGISTRATION_PEPPER)) {
    issues.push("HACKATHON_REGISTRATION_CODE and HACKATHON_REGISTRATION_PEPPER are required in hackathon mode");
  }
  if (
    env.AUTH_EMAIL_DELIVERY_MODE === "webhook"
    && (!env.AUTH_EMAIL_FROM || !env.AUTH_EMAIL_WEBHOOK_URL || !env.AUTH_EMAIL_WEBHOOK_TOKEN)
  ) {
    issues.push("AUTH_EMAIL_FROM, AUTH_EMAIL_WEBHOOK_URL, and AUTH_EMAIL_WEBHOOK_TOKEN are required for webhook email delivery");
  }
  const oxylabsAuthorizationReference = env.OXYLABS_AUTHORIZATION_REFERENCE ?? env.REDDIT_APPROVAL_REFERENCE;
  const oxylabsValues = [env.OXYLABS_ENDPOINT, env.OXYLABS_PORT, env.OXYLABS_USERNAME, env.OXYLABS_PASSWORD, oxylabsAuthorizationReference];
  const explicitOxylabsValues = [env.OXYLABS_ENDPOINT, env.OXYLABS_PORT, env.OXYLABS_USERNAME, env.OXYLABS_PASSWORD, env.OXYLABS_AUTHORIZATION_REFERENCE];
  if (explicitOxylabsValues.some(Boolean) && !oxylabsValues.every(Boolean)) {
    issues.push("The four OXYLABS connection variables and OXYLABS_AUTHORIZATION_REFERENCE must be configured together");
  }
  if (deploymentMode === "public" && env.NODE_ENV === "production" && env.AUTH_EMAIL_DELIVERY_MODE !== "webhook") {
    issues.push("Production public mode requires webhook email delivery for verification and password reset");
  }
  if (mode === "live" && (!env.VERIFICATION_SIGNING_KEY || !env.VERIFICATION_SIGNING_KEY_ID)) {
    issues.push("VERIFICATION_SIGNING_KEY and VERIFICATION_SIGNING_KEY_ID are required outside demo mode");
  }
  if (
    mode === "live" &&
    (!env.KIMI_INPUT_COST_MICROS_PER_MILLION || BigInt(env.KIMI_INPUT_COST_MICROS_PER_MILLION) < 1n ||
      !env.KIMI_OUTPUT_COST_MICROS_PER_MILLION || BigInt(env.KIMI_OUTPUT_COST_MICROS_PER_MILLION) < 1n)
  ) {
    issues.push("Positive KIMI input and output price rates are required outside demo mode");
  }
  if (env.NODE_ENV === "production" && env.LOCAL_VAULT_MASTER_KEY) {
    issues.push("LOCAL_VAULT_MASTER_KEY is forbidden in production");
  }
  if (env.NODE_ENV === "production" && env.LOCAL_VAULT_DERIVE_FROM_AUTH) {
    issues.push("LOCAL_VAULT_DERIVE_FROM_AUTH is forbidden in production");
  }
  if (env.LOCAL_VAULT_DERIVE_FROM_AUTH && !env.BETTER_AUTH_SECRET) {
    issues.push("LOCAL_VAULT_DERIVE_FROM_AUTH requires BETTER_AUTH_SECRET");
  }
  if (env.LOCAL_VAULT_DERIVE_FROM_AUTH && env.LOCAL_VAULT_MASTER_KEY) {
    issues.push("Choose either LOCAL_VAULT_MASTER_KEY or LOCAL_VAULT_DERIVE_FROM_AUTH, not both");
  }

  for (const [name, value] of Object.entries(environment)) {
    if (name.startsWith("NEXT_PUBLIC_STRIPE_") && value && /^(?:rk|sk)_(?:test|live)_|^whsec_/.test(value)) {
      issues.push(`${name} must never expose a Stripe server secret`);
    }
  }
  if (env.BILLING_CHECKOUT_ENABLED && !env.BILLING_ENABLED) {
    issues.push("BILLING_CHECKOUT_ENABLED requires BILLING_ENABLED");
  }
  if (env.BILLING_PORTAL_ENABLED && !env.BILLING_ENABLED) {
    issues.push("BILLING_PORTAL_ENABLED requires BILLING_ENABLED");
  }
  if (env.CUSTOMER_CREDITS_ENFORCED && !env.BILLING_ENABLED) {
    issues.push("CUSTOMER_CREDITS_ENFORCED requires BILLING_ENABLED");
  }
  if (env.STRIPE_SECRET_KEY) {
    const keyMode = env.STRIPE_SECRET_KEY.includes("_live_") ? "live" : "test";
    if (keyMode !== env.STRIPE_MODE) issues.push("STRIPE_SECRET_KEY mode must match STRIPE_MODE");
  }
  if (env.BILLING_ENABLED && !env.DATABASE_URL) {
    issues.push("DATABASE_URL is required when billing is enabled");
  }
  if (env.BILLING_ENABLED && (!env.STRIPE_SECRET_KEY || !env.STRIPE_WEBHOOK_SECRET)) {
    issues.push("STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET are required when billing is enabled");
  }
  if (env.BILLING_PORTAL_ENABLED && !env.STRIPE_PORTAL_CONFIGURATION_ID) {
    issues.push("STRIPE_PORTAL_CONFIGURATION_ID is required when the Billing Portal is enabled");
  }
  const stripePriceIds = [
    env.STRIPE_PRICE_PLAN_STARTER_SGD_V1,
    env.STRIPE_PRICE_PLAN_BUILDER_SGD_V1,
    env.STRIPE_PRICE_PLAN_SCALE_SGD_V1,
    env.STRIPE_PRICE_PACK_100_SGD_V1,
    env.STRIPE_PRICE_PACK_300_SGD_V1,
    env.STRIPE_PRICE_PACK_1000_SGD_V1,
  ];
  if (env.BILLING_CHECKOUT_ENABLED && stripePriceIds.some((priceId) => !priceId)) {
    issues.push("All six Stripe catalog Price IDs are required when Checkout is enabled");
  }
  const duplicateStripePriceIds = stripePriceIds.filter((priceId): priceId is string => Boolean(priceId));
  if (new Set(duplicateStripePriceIds).size !== duplicateStripePriceIds.length) {
    issues.push("Stripe catalog Price IDs must be distinct");
  }

  const hasKms = Boolean(
    env.GCP_PROJECT_ID
      && env.GCP_PROJECT_NUMBER
      && env.GCP_SERVICE_ACCOUNT_EMAIL
      && env.GCP_WORKLOAD_IDENTITY_POOL_ID
      && env.GCP_WORKLOAD_IDENTITY_POOL_PROVIDER_ID
      && env.GCP_KMS_KEY_NAME
      && env.GCP_ARTIFACT_BUCKET
      && env.GCP_ARTIFACT_SIGNER_SERVICE_ACCOUNT,
  );
  const hasLocalDevelopmentVault = env.NODE_ENV !== "production"
    && Boolean(env.LOCAL_VAULT_MASTER_KEY || (env.LOCAL_VAULT_DERIVE_FROM_AUTH && env.BETTER_AUTH_SECRET));
  if (mode === "live" && !hasKms && !hasLocalDevelopmentVault) {
    issues.push("GCP workload identity/KMS configuration or a local development vault is required outside demo mode");
  }
  if (
    mode === "live" && hasKms &&
    env.GCP_SERVICE_ACCOUNT_EMAIL!.toLowerCase() === env.GCP_ARTIFACT_SIGNER_SERVICE_ACCOUNT!.toLowerCase()
  ) {
    issues.push("GCP runtime and artifact signer service accounts must be distinct");
  }
  if (mode === "live") {
    if (!env.PREVIEW_ORIGIN || !env.PREVIEW_SIGNING_KEY) {
      issues.push("PREVIEW_ORIGIN and PREVIEW_SIGNING_KEY are required outside demo mode");
    } else {
      const previewOrigin = new URL(env.PREVIEW_ORIGIN);
      if (previewOrigin.protocol !== "https:") issues.push("PREVIEW_ORIGIN must use HTTPS outside demo mode");
      if (previewOrigin.origin === appUrl || previewOrigin.origin === trustedOrigin) {
        issues.push("PREVIEW_ORIGIN must be a dedicated cookie-less origin outside demo mode");
      }
    }
  }
  const configuredSigningKeys = [env.BETTER_AUTH_SECRET, env.VERIFICATION_SIGNING_KEY, env.PREVIEW_SIGNING_KEY].filter(
    (value): value is string => Boolean(value),
  );
  if (mode === "live" && new Set(configuredSigningKeys).size !== configuredSigningKeys.length) {
    issues.push("Auth, verification, and preview signing keys must be independent");
  }

  if (issues.length > 0) throw new EnvironmentConfigurationError(issues);

  let vault: RuntimeConfig["vault"];
  if (hasLocalDevelopmentVault) {
    const masterKey = env.LOCAL_VAULT_MASTER_KEY ?? createHash("sha256")
      .update("reddone-local-vault:v1\0")
      .update(env.BETTER_AUTH_SECRET!)
      .digest("base64");
    vault = { kind: "local", masterKey };
  } else if (hasKms) {
    vault = {
      kind: "gcp-kms",
      projectId: env.GCP_PROJECT_ID!,
      projectNumber: env.GCP_PROJECT_NUMBER!,
      keyName: env.GCP_KMS_KEY_NAME!,
      artifactBucket: env.GCP_ARTIFACT_BUCKET!,
      serviceAccountEmail: env.GCP_SERVICE_ACCOUNT_EMAIL!,
      workloadIdentityPoolId: env.GCP_WORKLOAD_IDENTITY_POOL_ID!,
      workloadIdentityPoolProviderId: env.GCP_WORKLOAD_IDENTITY_POOL_PROVIDER_ID!,
      artifactSignerServiceAccount: env.GCP_ARTIFACT_SIGNER_SERVICE_ACCOUNT!,
    };
  } else {
    vault = { kind: "unavailable" };
  }

  let emailDelivery: RuntimeConfig["auth"]["emailDelivery"];
  if (
    env.AUTH_EMAIL_DELIVERY_MODE === "webhook"
    && env.AUTH_EMAIL_FROM
    && env.AUTH_EMAIL_WEBHOOK_URL
    && env.AUTH_EMAIL_WEBHOOK_TOKEN
  ) {
    emailDelivery = {
      kind: "webhook",
      endpoint: env.AUTH_EMAIL_WEBHOOK_URL,
      token: env.AUTH_EMAIL_WEBHOOK_TOKEN,
      from: env.AUTH_EMAIL_FROM,
    };
  } else if (env.NODE_ENV !== "production") {
    emailDelivery = { kind: "log" };
  } else {
    emailDelivery = { kind: "unavailable" };
  }

  return {
    environment: env.NODE_ENV,
    mode,
    deploymentMode,
    appUrl,
    timeZone: env.WORKSPACE_TIMEZONE,
    database: env.DATABASE_URL
      ? { url: env.DATABASE_URL, directUrl: env.DIRECT_URL ?? null }
      : null,
    auth: {
      secret: env.BETTER_AUTH_SECRET ?? null,
      setupTokenHash: env.SETUP_TOKEN_HASH ?? null,
      trustedOrigin,
      githubClientId: env.GITHUB_AUTH_CLIENT_ID ?? null,
      githubClientSecret: env.GITHUB_AUTH_CLIENT_SECRET ?? null,
      registrationCode: env.HACKATHON_REGISTRATION_CODE ?? null,
      registrationPepper: env.HACKATHON_REGISTRATION_PEPPER ?? null,
      ownerAccessCodePepper: env.OWNER_ACCESS_CODE_PEPPER ?? null,
      emailDelivery,
    },
    vault,
    providers: {
      kimiResearchModel: env.AIAND_RESEARCH_MODEL ?? env.KIMI_RESEARCH_MODEL ?? DEFAULT_AIAND_RESEARCH_MODEL,
      kimiBuilderModel: env.AIAND_BUILDER_MODEL ?? env.KIMI_BUILDER_MODEL ?? DEFAULT_AIAND_BUILDER_MODEL,
      oxylabsConfigured: Boolean(
        env.OXYLABS_ENDPOINT
        && env.OXYLABS_PORT
        && env.OXYLABS_USERNAME
        && env.OXYLABS_PASSWORD
        && oxylabsAuthorizationReference
      ),
    },
    preview: {
      origin: env.PREVIEW_ORIGIN ? new URL(env.PREVIEW_ORIGIN).origin : null,
      signingKeyConfigured: Boolean(env.PREVIEW_SIGNING_KEY),
    },
    billing: {
      enabled: env.BILLING_ENABLED,
      checkoutEnabled: env.BILLING_CHECKOUT_ENABLED,
      portalEnabled: env.BILLING_PORTAL_ENABLED,
      creditsEnforced: env.CUSTOMER_CREDITS_ENFORCED,
      stripeMode: env.STRIPE_MODE,
      secretKey: env.STRIPE_SECRET_KEY ?? null,
      webhookSecret: env.STRIPE_WEBHOOK_SECRET ?? null,
      portalConfigurationId: env.STRIPE_PORTAL_CONFIGURATION_ID ?? null,
      priceIds: {
        planStarterSgdV1: env.STRIPE_PRICE_PLAN_STARTER_SGD_V1 ?? null,
        planBuilderSgdV1: env.STRIPE_PRICE_PLAN_BUILDER_SGD_V1 ?? null,
        planScaleSgdV1: env.STRIPE_PRICE_PLAN_SCALE_SGD_V1 ?? null,
        pack100SgdV1: env.STRIPE_PRICE_PACK_100_SGD_V1 ?? null,
        pack300SgdV1: env.STRIPE_PRICE_PACK_300_SGD_V1 ?? null,
        pack1000SgdV1: env.STRIPE_PRICE_PACK_1000_SGD_V1 ?? null,
      },
    },
  };
}

export function isDemoMode(environment: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return getDeploymentMode(environment) === "demo";
}

export function isCustomerCreditsEnforced(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return getRuntimeConfig(environment).billing.creditsEnforced;
}

export function getVercelIntegrationSlug(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string | null {
  const parsed = RuntimeEnvSchema.safeParse(environment);
  if (!parsed.success) {
    throw new EnvironmentConfigurationError(parsed.error.issues.map((issue) => `${issue.path.join(".") || "environment"}: ${issue.message}`));
  }
  return parsed.data.VERCEL_INTEGRATION_SLUG ?? null;
}

export function isHackathonMode(environment: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return getDeploymentMode(environment) === "hackathon";
}

export function isPublicMode(environment: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return getDeploymentMode(environment) === "public";
}

export function isDatabaseConfigured(environment: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return getRuntimeConfig(environment).database !== null;
}

/** Progressive conversation controls are intentionally fail-closed and hierarchical. */
export function getConversationFeatureFlags(environment: Readonly<Record<string, string | undefined>> = process.env) {
  const parsed = RuntimeEnvSchema.safeParse(environment);
  if (!parsed.success) {
    throw new EnvironmentConfigurationError(parsed.error.issues.map((issue) => `${issue.path.join(".") || "environment"}: ${issue.message}`));
  }
  const env = parsed.data;
  const workspace = env.PROJECT_WORKSPACE_ENABLED;
  const conversations = workspace && env.PROJECT_CONVERSATIONS_ENABLED;
  const agent = conversations && env.PROJECT_CONVERSATION_AGENT_ENABLED && Boolean(env.DAYTONA_AGENT_SNAPSHOT);
  const mutations = agent && env.PROJECT_CONVERSATION_MUTATIONS_ENABLED;
  const autopilot = mutations && env.PROJECT_CONVERSATION_AUTOPILOT_ENABLED;
  return { workspace, conversations, agent, mutations, autopilot, agentSnapshot: env.DAYTONA_AGENT_SNAPSHOT ?? null };
}
