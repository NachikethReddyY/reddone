import { z } from "zod";
import { createHash } from "node:crypto";

import { verifySha256Webhook } from "@/policy/webhook";
import { getDb } from "@/server/db";
import { isDemoMode } from "@/server/env";
import { markWebhookProcessed, receiveWebhook } from "@/server/webhook-inbox";
import { apiError, ok, requestId } from "@/workflows/http";

export async function POST(request: Request) {
  const id = requestId(request);
  const body = await request.text();
  if (!verifySha256Webhook({ body, signature: request.headers.get("x-hub-signature-256"), secret: process.env.GITHUB_WEBHOOK_SECRET })) {
    return apiError(id, "forbidden", "Invalid GitHub webhook signature.", 403);
  }
  const event = request.headers.get("x-github-event") ?? "unknown";
  const delivery = request.headers.get("x-github-delivery");
  if (!delivery) return apiError(id, "bad_request", "GitHub delivery ID is required.", 400);
  const payload = z.record(z.string(), z.unknown()).parse(JSON.parse(body));
  if (isDemoMode()) {
    return ok({ accepted: true, provider: "github", event, delivery, action: payload.action ?? null, mode: "demo" }, id, { status: 202 });
  }
  const installation = payload.installation as { id?: number } | undefined;
  if (!installation?.id) return apiError(id, "bad_request", "GitHub installation ID is required.", 400);
  const connection = await getDb().providerConnection.findFirst({
    where: { provider: "GITHUB", accountExternalId: String(installation.id) },
  });
  if (!connection) return apiError(id, "forbidden", "Webhook is not scoped to the connected GitHub installation.", 403);
  const receipt = await receiveWebhook({
    workspaceId: connection.workspaceId,
    consumer: "github",
    messageId: delivery,
    payloadHash: createHash("sha256").update(body).digest("hex"),
  });
  if (!receipt.replayed && event === "installation" && (payload.action === "deleted" || payload.action === "suspend")) {
    await getDb().providerConnection.update({
      where: { id: connection.id },
      data: {
        health: "REVOKED",
        failureCode: `installation_${String(payload.action)}`,
        disconnectedAt: new Date(),
        optimisticVersion: { increment: 1 },
      },
    });
  }
  if (!receipt.replayed) await markWebhookProcessed({ workspaceId: connection.workspaceId, receiptId: receipt.receipt.id });
  return ok({ accepted: true, provider: "github", event, delivery, action: payload.action ?? null, replayed: receipt.replayed }, id, { status: 202 });
}
