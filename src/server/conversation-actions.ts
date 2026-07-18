import "server-only";

import { createHash } from "node:crypto";

import { z } from "zod";

import { canonicalJson } from "@/server/security/canonical-json";

import { getDb } from "./db";
import { executeProjectLifecycleCommand, type ProjectLifecycleCommand } from "./project-commands";

const LifecycleActionPayloadSchema = z.object({ command: z.enum(["project.pause", "project.resume"]) }).strict();
const allowedAutopilotCommands = new Set<ProjectLifecycleCommand>(["project.pause", "project.resume"]);

export async function proposeProjectLifecycleAction(input: {
  workspaceId: string;
  projectId: string;
  conversationId: string;
  turnId: string;
  command: ProjectLifecycleCommand;
  expectedProjectVersion: number;
}) {
  const payload = LifecycleActionPayloadSchema.parse({ command: input.command });
  const payloadHash = createHash("sha256").update(canonicalJson(payload)).digest("hex");
  const currentStatus = input.command === "project.pause" ? "active" : "paused";
  const targetStatus = input.command === "project.pause" ? "paused" : "active";
  return getDb().conversationAction.create({
    data: {
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      conversationId: input.conversationId,
      turnId: input.turnId,
      command: input.command,
      schemaVersion: "project-lifecycle-v1",
      payload,
      payloadHash,
      expectedProjectVersion: input.expectedProjectVersion,
      risk: "LOW",
      diff: { status: { before: currentStatus, after: targetStatus } },
      expiresAt: new Date(Date.now() + 15 * 60_000),
    },
  });
}

export async function dismissConversationAction(input: {
  workspaceId: string;
  projectId: string;
  conversationId: string;
  actionId: string;
  expectedProjectVersion: number;
}) {
  return getDb().$transaction(async (tx) => {
    const project = await tx.project.findUnique({
      where: { workspaceId_id: { workspaceId: input.workspaceId, id: input.projectId } },
      select: { optimisticVersion: true },
    });
    if (!project || project.optimisticVersion !== input.expectedProjectVersion) throw new Error("Project version conflict.");
    const action = await tx.conversationAction.findFirst({
      where: { id: input.actionId, workspaceId: input.workspaceId, projectId: input.projectId, conversationId: input.conversationId },
    });
    if (!action) throw new Error("Conversation action not found.");
    if (action.status !== "PROPOSED") throw new Error("Conversation action is no longer pending.");
    await tx.conversationAction.update({ where: { id: action.id }, data: { status: "DISMISSED" } });
    return { id: action.id, status: "dismissed" as const };
  });
}

export async function executeConversationAction(input: {
  workspaceId: string;
  projectId: string;
  conversationId: string;
  actionId: string;
  expectedProjectVersion: number;
  actorUserId: string;
  requestId: string;
}) {
  const claimed = await getDb().$transaction(async (tx) => {
    const project = await tx.project.findUnique({
      where: { workspaceId_id: { workspaceId: input.workspaceId, id: input.projectId } },
      select: { optimisticVersion: true, authorityMode: true },
    });
    if (!project || project.optimisticVersion !== input.expectedProjectVersion) throw new Error("Project version conflict.");
    if (project.authorityMode === "READ_ONLY") throw new Error("Read-only conversation mode cannot execute actions.");
    const action = await tx.conversationAction.findFirst({
      where: { id: input.actionId, workspaceId: input.workspaceId, projectId: input.projectId, conversationId: input.conversationId },
    });
    if (!action) throw new Error("Conversation action not found.");
    if (action.status !== "PROPOSED" || action.expiresAt.getTime() <= Date.now()) {
      if (action.status === "PROPOSED") await tx.conversationAction.update({ where: { id: action.id }, data: { status: "EXPIRED" } });
      throw new Error("Conversation action is expired or no longer pending.");
    }
    if (action.expectedProjectVersion !== project.optimisticVersion || action.risk !== "LOW") {
      await tx.conversationAction.update({ where: { id: action.id }, data: { status: "SUPERSEDED" } });
      throw new Error("Conversation action is stale or not eligible for execution.");
    }
    const payload = LifecycleActionPayloadSchema.safeParse(action.payload);
    if (!payload.success || action.command !== payload.data.command) throw new Error("Conversation action payload is invalid.");
    if (project.authorityMode === "AUTOPILOT" && !allowedAutopilotCommands.has(payload.data.command)) {
      throw new Error("Autopilot policy does not allow this action.");
    }
    const changed = await tx.conversationAction.updateMany({
      where: { id: action.id, status: "PROPOSED" },
      data: { status: "EXECUTING" },
    });
    if (changed.count !== 1) throw new Error("Conversation action changed while being executed.");
    return { action, command: payload.data.command as ProjectLifecycleCommand };
  });

  try {
    const result = await executeProjectLifecycleCommand({
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      expectedProjectVersion: input.expectedProjectVersion,
      command: claimed.command,
    });
    await getDb().$transaction(async (tx) => {
      const audit = await tx.auditEvent.create({
        data: {
          workspaceId: input.workspaceId,
          actorUserId: input.actorUserId,
          action: "conversation.action.executed",
          targetType: "project",
          targetId: input.projectId,
          requestId: input.requestId,
          metadata: { command: claimed.command, actionId: input.actionId },
          expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60_000),
        },
      });
      await tx.conversationAction.update({
        where: { id: input.actionId },
        data: { status: "EXECUTED", result, auditEventId: audit.id },
      });
    });
    return { id: input.actionId, status: "executed" as const, result };
  } catch (error) {
    await getDb().conversationAction.updateMany({
      where: { id: input.actionId, status: "EXECUTING" },
      data: { status: "FAILED", result: { code: "command_failed" } },
    });
    throw error;
  }
}
