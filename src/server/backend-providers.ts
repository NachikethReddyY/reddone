import "server-only";

import { createHmac } from "node:crypto";

import { z } from "zod";

import { OxylabsResidentialCredentialSchema, type OxylabsResidentialCredentials } from "@/integrations/oxylabs-reddit";

import { getDb } from "./db";
import { getRuntimeConfig } from "./env";
import { readProviderCredential } from "./secret-vault";

export type BackendProvider = "kimi" | "daytona";

function kimiEnvironmentKey() {
  return process.env.AIAND_API_KEY?.trim() || process.env.KIMI_API_KEY?.trim() || process.env.MOONSHOT_API_KEY?.trim() || null;
}

function daytonaEnvironmentKey() {
  return process.env.DAYTONA_API_KEY?.trim() || null;
}

function oxylabsResidentialEnvironmentCredentials(): OxylabsResidentialCredentials | null {
  const parsed = OxylabsResidentialCredentialSchema.safeParse({
    endpoint: process.env.OXYLABS_ENDPOINT,
    port: process.env.OXYLABS_PORT ?? "7777",
    username: process.env.OXYLABS_USERNAME,
    password: process.env.OXYLABS_PASSWORD,
    approvalReference: process.env.OXYLABS_AUTHORIZATION_REFERENCE ?? process.env.REDDIT_APPROVAL_REFERENCE,
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
    throw new Error(`${provider === "kimi" ? "AIand inference" : "Daytona"} is not configured in the backend.`);
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

/** Oxylabs residential access is backend infrastructure, never a browser connection. */
export function getBackendRedditResidentialCredentials(): OxylabsResidentialCredentials {
  const configured = oxylabsResidentialEnvironmentCredentials();
  if (!configured) {
    throw new Error("Live discovery requires Oxylabs credentials and a written OXYLABS_AUTHORIZATION_REFERENCE in the backend.");
  }
  return configured;
}

export async function getBackendProviderReadiness(workspaceId: string) {
  const environment = {
    aiand: Boolean(kimiEnvironmentKey()),
    daytona: Boolean(daytonaEnvironmentKey()),
    oxylabs: Boolean(oxylabsResidentialEnvironmentCredentials()),
  };
  const missing = [
    ...(!environment.aiand ? ["KIMI" as const] : []),
    ...(!environment.daytona ? ["DAYTONA" as const] : []),
  ];
  const legacy = missing.length
    ? await getDb().providerConnection.findMany({
      where: { workspaceId, provider: { in: missing }, health: "HEALTHY", activeSecretVersionId: { not: null } },
      select: { provider: true, authorizationRef: true },
    })
    : [];
  const legacyReady = new Map(legacy.map((connection) => [
    connection.provider.toLowerCase() as BackendProvider,
    true,
  ]));
  const ready = {
    aiand: environment.aiand || legacyReady.get("kimi") === true,
    daytona: environment.daytona || legacyReady.get("daytona") === true,
    oxylabs: environment.oxylabs,
  };
  return {
    providers: ready,
    discoveryReady: ready.aiand && ready.oxylabs,
    buildReady: ready.aiand && ready.daytona,
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
    throw new Error("AIand inference and Daytona must both be configured in the backend.");
  }
  return connections.map((connection) => ({
    provider: connection.provider.toLowerCase() as "kimi" | "daytona",
    accountId: connection.accountExternalId ?? connection.id,
  }));
}

export const BackendProviderReadinessSchema = z.object({
  providers: z.object({ aiand: z.boolean(), daytona: z.boolean(), oxylabs: z.boolean() }).strict(),
  discoveryReady: z.boolean(),
  buildReady: z.boolean(),
}).strict();
