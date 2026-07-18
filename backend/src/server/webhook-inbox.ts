import "server-only";

import { Prisma } from "@prisma/client";

import { getDb } from "./db";

const WEBHOOK_PROCESSING_LEASE_MS = 10 * 60 * 1_000;

export async function receiveWebhook(input: {
  workspaceId: string;
  consumer: "github" | "vercel";
  messageId: string;
  payloadHash: string;
}) {
  const db = getDb();
  try {
    const receipt = await db.inboxReceipt.create({
      data: {
        workspaceId: input.workspaceId,
        consumer: input.consumer,
        messageId: input.messageId,
        payloadHash: input.payloadHash,
      },
    });
    return { receipt, replayed: false };
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const existing = await db.inboxReceipt.findUniqueOrThrow({
        where: {
          workspaceId_consumer_messageId: {
            workspaceId: input.workspaceId,
            consumer: input.consumer,
            messageId: input.messageId,
          },
        },
      });
      if (existing.payloadHash !== input.payloadHash) throw new Error("Webhook delivery ID was reused with a different payload.");
      if (existing.processedAt) return { receipt: existing, replayed: true };

      const now = new Date();
      const claimed = await db.inboxReceipt.updateMany({
        where: {
          id: existing.id,
          workspaceId: input.workspaceId,
          processedAt: null,
          processingAt: { lt: new Date(now.getTime() - WEBHOOK_PROCESSING_LEASE_MS) },
        },
        data: { processingAt: now },
      });
      return { receipt: existing, replayed: claimed.count !== 1 };
    }
    throw error;
  }
}

export async function markWebhookProcessed(input: { workspaceId: string; receiptId: string }) {
  const updated = await getDb().inboxReceipt.updateMany({
    where: { id: input.receiptId, workspaceId: input.workspaceId, processedAt: null },
    data: { processedAt: new Date() },
  });
  if (updated.count !== 1) {
    const existing = await getDb().inboxReceipt.findFirst({ where: { id: input.receiptId, workspaceId: input.workspaceId } });
    if (!existing?.processedAt) throw new Error("Webhook receipt could not be marked processed.");
  }
}
