import "server-only";

import { createHmac } from "node:crypto";

import { z } from "zod";

import { OxylabsResidentialCredentialSchema, type OxylabsResidentialCredentials } from "@/integrations/oxylabs-reddit";
import { RedditStoredCredentialSchema, type RedditCredentials } from "@/integrations/reddit";

import { getDb } from "./db";
import { getRuntimeConfig } from "./env";
import { readProviderCredential } from "./secret-vault";

export type BackendProvider = "kimi" | "daytona" | "reddit";

function kimiEnvironmentKey() {
  return process.env.AIAND_API_KEY?.trim() || process.env.KIMI_API_KEY?.trim() || process.env.MOONSHOT_API_KEY?.trim() || null;
}

function daytonaEnvironmentKey() {
  return process.env.DAYTONA_API_KEY?.trim() || null;
}

function redditEnvironmentCredentials(): RedditCredentials | null {
  const parsed = RedditStoredCredentialSchema.safeParse({
    clientId: process.env.REDDIT_CLIENT_ID,
    clientSecret: process.env.REDDIT_CLIENT_SECRET,
    userAgent: process.env.REDDIT_USER_AGENT,
  });
  const approvalReference = process.env.REDDIT_APPROVAL_REFERENCE?.trim();
  return parsed.success && approvalReference ? { ...parsed.data, approvalReference } : null;
}

function oxylabsResidentialEnvironmentCredentials(): OxylabsResidentialCredentials | null {
  const parsed = OxylabsResidentialCredentialSchema.safeParse({
    endpoint: process.env.OXYLABS_ENDPOINT,
    port: process.env.OXYLABS_PORT ?? "7777",
    username: process.env.OXYLABS_USERNAME,
    password: process.env.OXYLABS_PASSWORD,
    userAgent: process.env.REDDIT_USER_AGENT,
    approvalReference: process.env.REDDIT_APPROVAL_REFERENCE,
  });
  return parsed.success ? parsed.data : null;
}

async function legacyConnection(workspaceId: string, provider: BackendProvider) {
  return getDb().providerConnection.findUnique({
    where: {
      workspaceId_provider: {
        workspaceId,
        provider: provider.toUpperCase() as Uppercase<BackendProvider>,
      },
    },
    select: {
      id: true,
      health: true,
      authorizationRef: true,
      activeSecretVersionId: true,
    },
  });
}

async function requireLegacyCredential(workspaceId: string, provider: BackendProvider) {
  const connection = await legacyConnection(workspaceId, provider);
  if (!connection || connection.health !== "HEALTHY" || !connection.activeSecretVersionId) {
    throw new Error(`${provider === "kimi" ? "Kimi" : provider === "daytona" ? "Daytona" : "Reddit"} is not configured in the backend.`);
  }
  return { connection, credential: await readProviderCredential({ workspaceId, provider }) };
}

export async function getBackendKimiApiKey(workspaceId: string) {
  const configured = kimiEnvironmentKey();
  if (configured) return configured;
  return (await requireLegacyCredential(workspaceId, "kimi")).credential;
}

export async function getBackendDaytonaApiKey(workspaceId: string) {
  const configured = daytonaEnvironmentKey();
  if (configured) return configured;
  return (await requireLegacyCredential(workspaceId, "daytona")).credential;
}

export async function getBackendRedditCredentials(workspaceId: string): Promise<RedditCredentials> {
  const configured = redditEnvironmentCredentials();
  if (configured) return configured;
  const legacy = await requireLegacyCredential(workspaceId, "reddit");
  const credential = RedditStoredCredentialSchema.parse(JSON.parse(legacy.credential));
  const approvalReference = legacy.connection.authorizationRef?.trim();
  if (!approvalReference) throw new Error("Reddit backend access requires a recorded authorization reference.");
  return { ...credential, approvalReference };
}

/** Oxylabs residential access is backend infrastructure, never a browser connection. */
export function getBackendRedditResidentialCredentials(): OxylabsResidentialCredentials {
  const configured = oxylabsResidentialEnvironmentCredentials();
  if (!configured) {
    throw new Error("Oxylabs residential Reddit scraping requires OXYLABS credentials, a descriptive REDDIT_USER_AGENT, and a written Reddit approval reference.");
  }
  return configured;
}

export async function getBackendProviderReadiness(workspaceId: string) {
  const environment = {
    kimi: Boolean(kimiEnvironmentKey()),
    daytona: Boolean(daytonaEnvironmentKey()),
    reddit: Boolean(redditEnvironmentCredentials()),
    redditWebScraper: Boolean(oxylabsResidentialEnvironmentCredentials()),
  };
  const missing = (["kimi", "daytona", "reddit"] as const)
    .filter((provider) => !environment[provider])
    .map((provider) => provider.toUpperCase() as Uppercase<BackendProvider>);
  const legacy = missing.length
    ? await getDb().providerConnection.findMany({
      where: { workspaceId, provider: { in: missing }, health: "HEALTHY", activeSecretVersionId: { not: null } },
      select: { provider: true, authorizationRef: true },
    })
    : [];
  const legacyReady = new Map(legacy.map((connection) => [
    connection.provider.toLowerCase() as BackendProvider,
    connection.provider !== "REDDIT" || Boolean(connection.authorizationRef),
  ]));
  const ready = {
    kimi: environment.kimi || legacyReady.get("kimi") === true,
    daytona: environment.daytona || legacyReady.get("daytona") === true,
    reddit: environment.reddit || legacyReady.get("reddit") === true,
    redditWebScraper: environment.redditWebScraper,
  };
  return {
    providers: ready,
    discoveryReady: ready.kimi && ready.reddit,
    buildReady: ready.kimi && ready.daytona,
  };
}

function environmentAccountId(provider: "kimi" | "daytona", credential: string) {
  const signingKey = getRuntimeConfig().auth.secret;
  if (!signingKey) return `backend:${provider}:configured`;
  const digest = createHmac("sha256", signingKey)
    .update(`reddone-backend-provider:v1:${provider}:`)
    .update(credential)
    .digest("hex")
    .slice(0, 24);
  return `backend:${provider}:${digest}`;
}

export async function getBackendBuildProviderAccounts(workspaceId: string) {
  const kimiKey = kimiEnvironmentKey();
  const daytonaKey = daytonaEnvironmentKey();
  if (kimiKey && daytonaKey) {
    return [
      { provider: "kimi" as const, accountId: environmentAccountId("kimi", kimiKey) },
      { provider: "daytona" as const, accountId: environmentAccountId("daytona", daytonaKey) },
    ];
  }
  const connections = await getDb().providerConnection.findMany({
    where: { workspaceId, provider: { in: ["KIMI", "DAYTONA"] }, health: "HEALTHY", activeSecretVersionId: { not: null } },
    orderBy: { provider: "asc" },
  });
  if (!connections.some((connection) => connection.provider === "KIMI")
    || !connections.some((connection) => connection.provider === "DAYTONA")) {
    throw new Error("Kimi and Daytona must both be configured in the backend.");
  }
  return connections.map((connection) => ({
    provider: connection.provider.toLowerCase() as "kimi" | "daytona",
    accountId: connection.accountExternalId ?? connection.id,
  }));
}

export const BackendProviderReadinessSchema = z.object({
  providers: z.object({ kimi: z.boolean(), daytona: z.boolean(), reddit: z.boolean(), redditWebScraper: z.boolean() }).strict(),
  discoveryReady: z.boolean(),
  buildReady: z.boolean(),
}).strict();
