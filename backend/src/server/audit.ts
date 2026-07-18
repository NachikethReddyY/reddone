import "server-only";

import { createHash } from "node:crypto";

import type { JsonValue } from "@/contracts";
import type { Prisma } from "@prisma/client";

import { getDb } from "./db";
import { redactValue } from "./security/redaction";

export async function recordAuditEvent(input: {
  workspaceId: string;
  actorUserId?: string;
  action: string;
  targetType: string;
  targetId: string;
  requestId?: string;
  ipAddress?: string;
  metadata?: unknown;
}) {
  const redacted = redactValue(input.metadata ?? {}) as JsonValue;
  const metadata = (redacted === null ? {} : redacted) as Prisma.InputJsonValue;
  return getDb().auditEvent.create({
    data: {
      workspaceId: input.workspaceId,
      actorUserId: input.actorUserId ?? null,
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId,
      requestId: input.requestId ?? null,
      ipHash: input.ipAddress ? createHash("sha256").update(input.ipAddress).digest("hex") : null,
      metadata,
      expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60_000),
    },
  });
}
