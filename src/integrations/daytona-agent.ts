import "server-only";

import { Daytona, type Sandbox } from "@daytona/sdk";

import { IntegrationError } from "./errors";

const MAX_CONTEXT_BYTES = 24 * 1024;
const CONTEXT_PATH = ".reddone/project-context.json";

function client(apiKey: string) {
  return new Daytona({
    apiKey,
    ...(process.env.DAYTONA_API_URL ? { apiUrl: process.env.DAYTONA_API_URL } : {}),
    ...(process.env.DAYTONA_TARGET ? { target: process.env.DAYTONA_TARGET } : {}),
    otelEnabled: false,
  });
}

async function destroy(clientInstance: Daytona, sandbox: Sandbox) {
  try {
    await clientInstance.delete(sandbox, 60);
  } finally {
    await clientInstance[Symbol.asyncDispose]();
  }
}

/**
 * An agent sandbox can receive a sealed context package but exposes no model-callable
 * command, filesystem, provider, vault, or networking operation. It is deliberately
 * separate from the builder/verifier sandbox handle.
 */
export async function createConversationAgentSandbox(input: {
  apiKey: string;
  turnId: string;
  contextPackage: unknown;
}) {
  const snapshot = process.env.DAYTONA_AGENT_SNAPSHOT;
  if (!snapshot) throw new IntegrationError("not_configured", "The pinned conversation agent snapshot is not configured.", false, 400);
  const body = Buffer.from(JSON.stringify(input.contextPackage), "utf8");
  if (body.byteLength > MAX_CONTEXT_BYTES) {
    throw new IntegrationError("invalid_response", "Conversation context package exceeds the sandbox byte limit.", false, 422);
  }
  const sdk = client(input.apiKey);
  try {
    const sandbox = await sdk.create({
      snapshot,
      name: `reddone-conversation-${input.turnId.slice(0, 12)}`,
      language: "typescript",
      envVars: {},
      labels: { app: "reddone", purpose: "conversation-agent", turn: input.turnId },
      public: false,
      ephemeral: true,
      autoStopInterval: 15,
      autoDeleteInterval: 0,
      networkBlockAll: true,
    }, { timeout: 120 });
    try {
      await sandbox.fs.uploadFile(body, CONTEXT_PATH, 30);
    } catch (error) {
      await destroy(sdk, sandbox);
      throw error;
    }
    return {
      id: sandbox.id,
      contextPath: CONTEXT_PATH,
      destroy: () => destroy(sdk, sandbox),
    };
  } catch (error) {
    await sdk[Symbol.asyncDispose]();
    if (error instanceof IntegrationError) throw error;
    throw new IntegrationError("provider_error", "Daytona could not create the conversation agent sandbox.", true);
  }
}

export async function cleanupConversationAgentSandboxes(apiKey: string, turnId: string) {
  const sdk = client(apiKey);
  try {
    for await (const sandbox of sdk.list({ labels: { app: "reddone", purpose: "conversation-agent", turn: turnId } })) {
      await sdk.delete(sandbox, 60);
    }
    const remaining: string[] = [];
    for await (const sandbox of sdk.list({ labels: { app: "reddone", purpose: "conversation-agent", turn: turnId } })) remaining.push(sandbox.id);
    return { confirmed: remaining.length === 0, remaining };
  } finally {
    await sdk[Symbol.asyncDispose]();
  }
}
