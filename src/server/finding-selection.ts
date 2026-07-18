import "server-only";

import { createHash } from "node:crypto";

import { z } from "zod";

import { getDb } from "./db";
import { canonicalJson } from "./security/canonical-json";

const FINDING_SELECTION_EVENT = "project.finding.selected";

const FindingSelectionReceiptSchema = z
  .object({
    schemaVersion: z.literal(1),
    requestFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    projectId: z.string().min(1).max(128),
    findingId: z.string().min(1).max(128),
    selectedAt: z.string().datetime({ offset: true }),
    optimisticVersion: z.number().int().nonnegative(),
    currentBlocker: z.string().min(1).max(500),
  })
  .strict();

function requestFingerprint(input: { projectId: string; findingId: string; expectedProjectVersion: number }) {
  return createHash("sha256")
    .update(canonicalJson(input))
    .digest("hex");
}

function payloadHash(payload: unknown) {
  return createHash("sha256").update(canonicalJson(payload)).digest("hex");
}

function parseReplay(
  event: { eventType: string; payload: unknown; payloadHash: string },
  fingerprint: string,
) {
  if (event.eventType !== FINDING_SELECTION_EVENT) {
    throw new Error("The idempotency key was already used for a different mutation.");
  }
  const payload = FindingSelectionReceiptSchema.parse(event.payload);
  if (payload.requestFingerprint !== fingerprint || event.payloadHash !== payloadHash(payload)) {
    throw new Error("The idempotency key was already used for different finding-selection input.");
  }
  return payload;
}

export async function selectProjectFinding(input: {
  workspaceId: string;
  projectId: string;
  findingId: string;
  expectedProjectVersion: number;
  idempotencyKey: string;
  actorUserId: string;
  requestId: string;
}) {
  const db = getDb();
  const fingerprint = requestFingerprint({
    projectId: input.projectId,
    findingId: input.findingId,
    expectedProjectVersion: input.expectedProjectVersion,
  });
  const existing = await db.outboxEvent.findUnique({
    where: { workspaceId_idempotencyKey: { workspaceId: input.workspaceId, idempotencyKey: input.idempotencyKey } },
    select: { eventType: true, payload: true, payloadHash: true },
  });
  if (existing) return { ...parseReplay(existing, fingerprint), replayed: true };

  try {
    const result = await db.$transaction(
      async (tx) => {
      const raced = await tx.outboxEvent.findUnique({
        where: { workspaceId_idempotencyKey: { workspaceId: input.workspaceId, idempotencyKey: input.idempotencyKey } },
        select: { eventType: true, payload: true, payloadHash: true },
      });
      if (raced) return { ...parseReplay(raced, fingerprint), replayed: true };

      const project = await tx.project.findUnique({
        where: { workspaceId_id: { workspaceId: input.workspaceId, id: input.projectId } },
      });
      if (!project) throw new Error("Project not found.");
      if (project.optimisticVersion !== input.expectedProjectVersion) throw new Error("Project version conflict.");
      if (project.currentSpecVersionId) throw new Error("The ProductSpec basis cannot change after a specification exists.");
      if (["PAUSED", "ARCHIVED"].includes(project.status)) throw new Error("The project is not accepting finding decisions.");
      const activeRun = await tx.workflowRun.findFirst({
        where: {
          workspaceId: input.workspaceId,
          projectId: input.projectId,
          status: { in: ["QUEUED", "RUNNING", "WAITING_FOR_APPROVAL", "CANCEL_REQUESTED"] },
        },
        select: { id: true },
      });
      if (activeRun) throw new Error("A workflow is active; wait for it to finish before changing the selected finding.");
      const finding = await tx.finding.findUnique({
        where: {
          workspaceId_projectId_id: {
            workspaceId: input.workspaceId,
            projectId: input.projectId,
            id: input.findingId,
          },
        },
        include: { evidence: { select: { id: true }, take: 1 } },
      });
      if (!finding || finding.evidence.length === 0) throw new Error("Finding not found or it has no attributable evidence.");

      const selectedAt = new Date();
      await tx.finding.updateMany({
        where: { workspaceId: input.workspaceId, projectId: input.projectId, selectedAt: { not: null } },
        data: { selectedAt: null },
      });
      await tx.finding.update({
        where: {
          workspaceId_projectId_id: {
            workspaceId: input.workspaceId,
            projectId: input.projectId,
            id: finding.id,
          },
        },
        data: { selectedAt },
      });
      const currentBlocker = "Generate a ProductSpec from the selected finding";
      const updated = await tx.project.update({
        where: { workspaceId_id: { workspaceId: input.workspaceId, id: project.id } },
        data: {
          selectedFindingId: finding.id,
          status: "DRAFT",
          currentBlocker,
          optimisticVersion: { increment: 1 },
        },
      });
      const payload = FindingSelectionReceiptSchema.parse({
        schemaVersion: 1,
        requestFingerprint: fingerprint,
        projectId: project.id,
        findingId: finding.id,
        selectedAt: selectedAt.toISOString(),
        optimisticVersion: updated.optimisticVersion,
        currentBlocker,
      });
      await tx.outboxEvent.create({
        data: {
          workspaceId: input.workspaceId,
          aggregateType: "project_finding_selection",
          aggregateId: project.id,
          aggregateVersion: updated.optimisticVersion,
          eventType: FINDING_SELECTION_EVENT,
          payload,
          payloadHash: payloadHash(payload),
          idempotencyKey: input.idempotencyKey,
          publishedAt: selectedAt,
        },
      });
      await tx.auditEvent.create({
        data: {
          workspaceId: input.workspaceId,
          actorUserId: input.actorUserId,
          action: FINDING_SELECTION_EVENT,
          targetType: "finding",
          targetId: finding.id,
          requestId: input.requestId,
          metadata: { projectId: project.id, projectOptimisticVersion: updated.optimisticVersion },
          expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60_000),
        },
      });
      return { ...payload, replayed: false };
      },
      { isolationLevel: "Serializable", timeout: 15_000 },
    );
    return result;
  } catch (error) {
    const replay = await db.outboxEvent.findUnique({
      where: { workspaceId_idempotencyKey: { workspaceId: input.workspaceId, idempotencyKey: input.idempotencyKey } },
      select: { eventType: true, payload: true, payloadHash: true },
    });
    if (replay) return { ...parseReplay(replay, fingerprint), replayed: true };
    throw error;
  }
}
