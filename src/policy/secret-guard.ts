const secretPatterns: Array<{ label: string; pattern: RegExp }> = [
  { label: "OpenAI-style API key", pattern: /\bsk-[A-Za-z0-9_-]{16,}\b/ },
  { label: "GitHub token", pattern: /\b(?:gh[opsu]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/ },
  { label: "AWS access key", pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/ },
  { label: "private key", pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  {
    label: "authorization header",
    pattern: /\bauthorization\s*[:=]\s*(?:bearer|basic)\s+[A-Za-z0-9+/_=.-]{12,}/i,
  },
  {
    label: "secret assignment",
    pattern: /\b(?:api[_-]?key|client[_-]?secret|access[_-]?token|password)\s*[:=]\s*["']?[A-Za-z0-9+/_=.-]{16,}/i,
  },
];

export interface SecretDetection {
  label: string;
  start: number;
  end: number;
}

export function detectSecretLikeInput(value: string): SecretDetection | null {
  for (const { label, pattern } of secretPatterns) {
    const match = pattern.exec(value);
    pattern.lastIndex = 0;
    if (match?.index !== undefined) {
      return { label, start: match.index, end: match.index + match[0].length };
    }
  }
  return null;
}

export function redactSecrets(value: string) {
  return secretPatterns.reduce((result, { pattern }) => result.replace(pattern, "[REDACTED]"), value);
}

export function assertNoSecretLikeInput(value: string) {
  const detection = detectSecretLikeInput(value);
  if (detection) {
    throw new Error(`Secret-like input (${detection.label}) belongs in Connections and was not saved.`);
  }
}

export function maskedSuffix(secret: string) {
  const normalized = secret.trim();
  if (normalized.length < 4) return "••••";
  return `•••• ${normalized.slice(-4)}`;
}

export const CONTROL_PLANE_SECRET_VALUE_ENV_NAMES = [
  "AIAND_API_KEY",
  "BETTER_AUTH_SECRET",
  "CRON_SECRET",
  "DATABASE_URL",
  "DAYTONA_API_KEY",
  "DIRECT_URL",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_CLIENT_SECRET",
  "GITHUB_TOKEN",
  "GITHUB_WEBHOOK_SECRET",
  "LOCAL_VAULT_MASTER_KEY",
  "KIMI_API_KEY",
  "MOONSHOT_API_KEY",
  "OXYLABS_PASSWORD",
  "PREVIEW_SIGNING_KEY",
  "REDDIT_CLIENT_ID",
  "REDDIT_CLIENT_SECRET",
  "SETUP_TOKEN",
  "SETUP_TOKEN_HASH",
  "VERCEL_INTEGRATION_CLIENT_SECRET",
  "VERCEL_TOKEN",
  "VERCEL_WEBHOOK_SECRET",
  "VERIFICATION_SIGNING_KEY",
] as const;

const reservedProjectRuntimeNames = new Set<string>([
  ...CONTROL_PLANE_SECRET_VALUE_ENV_NAMES,
  "GCP_ARTIFACT_BUCKET",
  "GCP_ARTIFACT_SIGNER_SERVICE_ACCOUNT",
  "GCP_KMS_KEY_NAME",
  "GCP_PROJECT_ID",
  "GCP_PROJECT_NUMBER",
  "GCP_SERVICE_ACCOUNT_EMAIL",
  "GCP_WORKLOAD_IDENTITY_POOL_ID",
  "GCP_WORKLOAD_IDENTITY_POOL_PROVIDER_ID",
  "GITHUB_AUTH_CLIENT_SECRET",
  "HACKATHON_REGISTRATION_PEPPER",
  "HACKATHON_REGISTRATION_CODE",
  "DAYTONA_BUILDER_SNAPSHOT",
  "DAYTONA_TARGET",
  "DAYTONA_VERIFIER_SNAPSHOT",
  "GITHUB_APP_ID",
  "GITHUB_APP_SLUG",
  "GITHUB_CLIENT_ID",
  "PREVIEW_ORIGIN",
  "PREVIEW_SIGNING_KEY_ID",
  "OXYLABS_AUTHORIZATION_REFERENCE",
  "REDDIT_APPROVAL_REFERENCE",
  "VERCEL_ALLOWED_TEAM_ID",
  "VERCEL_INTEGRATION_CLIENT_ID",
  "VERCEL_INTEGRATION_SLUG",
  "VERIFICATION_SIGNING_KEY_ID",
]);

export function assertProjectRuntimeSecretNameAllowed(nameInput: string) {
  const name = nameInput.trim().toUpperCase();
  if (reservedProjectRuntimeNames.has(name) || name.startsWith("REDDONE_") || name.startsWith("VERCEL_OIDC_")) {
    throw new Error("This name is reserved for a control-plane credential and cannot be granted to generated applications.");
  }
}
