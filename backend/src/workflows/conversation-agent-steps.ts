import "server-only";

import { createConversationAgentSandbox } from "@/integrations/daytona-agent";
import { generateKimiConversationResponse } from "@/integrations/kimi-conversation";
import { getBackendDaytonaApiKey, getBackendKimiApiKey } from "@/server/backend-providers";
import { getDb } from "@/server/db";
import { getConversationFeatureFlags } from "@/server/env";
import { readSafeProjectContext } from "@/server/project-agent";
import { assertNoSecretLikeInput } from "@/server/security/redaction";

import { proposeProjectLifecycleAction } from "@/server/conversation-actions";
import { recordConversationEvent } from "@/server/conversation-events";

async function safeContentHash(content: string) {
  const bytes = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(content));
  return Array.from(new Uint8Array(bytes), (value) => value.toString(16).padStart(2, "0")).join("");
}

function responseForProject(input: { name: string; status: string; blocker: string | null; message: string }) {
  const status = input.status.toLowerCase().replaceAll("_", " ");
  const blocker = input.blocker ? ` Current blocker: ${input.blocker}` : "";
  return `I checked the canonical project state for ${input.name}. It is currently ${status}.${blocker} Your request is recorded in this durable conversation; review the structured project views for the authoritative evidence, specification, runs, and approvals.`;
}

async function appendAssistantMessage(input: { workspaceId: string; projectId: string; conversationId: string; content: string }) {
  const db = getDb();
  await db.$transaction(async (tx) => {
    const next = await tx.conversationMessage.aggregate({
      where: { workspaceId: input.workspaceId, projectId: input.projectId, conversationId: input.conversationId },
      _max: { sequence: true },
    });
    await tx.conversationMessage.create({
      data: {
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        conversationId: input.conversationId,
        sequence: (next._max.sequence ?? 0) + 1,
        role: "ASSISTANT",
        content: input.content,
        contentHash: await safeContentHash(input.content),
      },
    });
  });
}

async function terminalizeCanceled(input: { workspaceId: string; projectId: string; conversationId: string; turnId: string }) {
  const db = getDb();
  const result = await db.conversationTurn.updateMany({
    where: { id: input.turnId, workspaceId: input.workspaceId, projectId: input.projectId, conversationId: input.conversationId, status: "CANCEL_REQUESTED" },
    data: { status: "CANCELED", finishedAt: new Date(), stateVersion: { increment: 1 } },
  });
  if (result.count === 1) {
    await recordConversationEvent({ ...input, type: "turn.canceled", payload: { status: "canceled", message: "Generation was canceled." } });
    await recordConversationEvent({ ...input, type: "turn.completed", payload: { status: "canceled" } });
  }
}

/** Durable bounded turn executor. It intentionally uses no generic tools while read-only tooling is gated. */
export async function executeConversationTurnStep(workspaceId: string, turnId: string) {
  "use step";
  const db = getDb();
  const turn = await db.$transaction(async (tx) => {
    const current = await tx.conversationTurn.findFirst({
      where: { id: turnId, workspaceId },
      include: { conversation: true },
    });
    if (!current || current.status !== "QUEUED") return null;
    const claimed = await tx.conversationTurn.updateMany({
      where: { id: turnId, workspaceId, status: "QUEUED", stateVersion: current.stateVersion },
      data: { status: "RUNNING", startedAt: new Date(), stateVersion: { increment: 1 } },
    });
    return claimed.count === 1 ? current : null;
  });
  if (!turn) return { turnId, status: "skipped" as const };

  const scope = { workspaceId, projectId: turn.projectId, conversationId: turn.conversationId, turnId };
  try {
    await recordConversationEvent({ ...scope, type: "turn.started", payload: { status: "running", message: "Reading canonical project state." } });
    const current = await db.conversationTurn.findFirst({
      where: { id: turnId, workspaceId, projectId: turn.projectId, conversationId: turn.conversationId },
      include: { conversation: true },
    });
    if (!current || current.status === "CANCEL_REQUESTED") {
      await terminalizeCanceled(scope);
      return { turnId, status: "canceled" as const };
    }
    const [project, ownerMessage] = await Promise.all([
      db.project.findUnique({
        where: { workspaceId_id: { workspaceId, id: turn.projectId } },
        select: { name: true, status: true, currentBlocker: true },
      }),
      db.conversationMessage.findUnique({ where: { id: current.ownerMessageId }, select: { content: true, authorUserId: true } }),
    ]);
    if (!project || !ownerMessage) throw new Error("Canonical conversation context is unavailable.");
    await recordConversationEvent({ ...scope, type: "agent.status", payload: { message: "Preparing a bounded read-only response." } });
    let reply = responseForProject({ name: project.name, status: project.status, blocker: project.currentBlocker, message: ownerMessage.content });
    if (getConversationFeatureFlags().agent) {
      const safeContext = await readSafeProjectContext({ workspaceId, projectId: turn.projectId });
      const [kimiApiKey, daytonaApiKey] = await Promise.all([
        getBackendKimiApiKey(workspaceId),
        getBackendDaytonaApiKey(workspaceId),
      ]);
      const sandbox = await createConversationAgentSandbox({ apiKey: daytonaApiKey, turnId, contextPackage: safeContext });
      try {
        await recordConversationEvent({ ...scope, type: "agent.status", payload: { message: "Generating a bounded read-only response." } });
        reply = (await generateKimiConversationResponse({ apiKey: kimiApiKey, safeContext, ownerMessage: ownerMessage.content })).content;
      } finally {
        await sandbox.destroy();
      }
    }
    assertNoSecretLikeInput(reply);
    const lifecycleCommand = /\bpause (?:this )?project\b/i.test(ownerMessage.content)
      ? "project.pause" as const
      : /\bresume (?:this )?project\b/i.test(ownerMessage.content)
        ? "project.resume" as const
        : null;
    if (lifecycleCommand && current.authorityMode !== "READ_ONLY") {
      const action = await proposeProjectLifecycleAction({
        workspaceId,
        projectId: turn.projectId,
        conversationId: turn.conversationId,
        turnId,
        command: lifecycleCommand,
        expectedProjectVersion: current.projectVersion,
      });
      await recordConversationEvent({ ...scope, type: "action.proposed", payload: { actionId: action.id, message: "A low-risk project lifecycle action is ready for review." } });
    }
    const beforeFinish = await db.conversationTurn.findUnique({ where: { id: turnId }, select: { status: true } });
    if (beforeFinish?.status === "CANCEL_REQUESTED") {
      await terminalizeCanceled(scope);
      return { turnId, status: "canceled" as const };
    }
    await recordConversationEvent({ ...scope, type: "assistant.delta", payload: { delta: reply }, expiresAt: new Date(Date.now() + 24 * 60 * 60_000) });
    await appendAssistantMessage({ ...scope, content: reply });
    const terminal = await db.conversationTurn.updateMany({
      where: { id: turnId, workspaceId, status: "RUNNING" },
      data: { status: "COMPLETED", partialResponse: reply, finishedAt: new Date(), stateVersion: { increment: 1 } },
    });
    if (terminal.count !== 1) {
      await terminalizeCanceled(scope);
      return { turnId, status: "canceled" as const };
    }
    await recordConversationEvent({ ...scope, type: "assistant.completed", payload: { message: "Assistant response committed." } });
    await recordConversationEvent({ ...scope, type: "turn.completed", payload: { status: "completed" } });
    return { turnId, status: "completed" as const };
  } catch (error) {
    const message = "The conversation turn could not be completed safely.";
    await db.conversationTurn.updateMany({
      where: { id: turnId, workspaceId, status: { in: ["QUEUED", "RUNNING"] } },
      data: { status: "FAILED", failureCode: "conversation_execution_failed", failureMessage: message, finishedAt: new Date(), stateVersion: { increment: 1 } },
    });
    await recordConversationEvent({ ...scope, type: "turn.failed", payload: { status: "failed", message } }).catch(() => undefined);
    throw error;
  }
}
