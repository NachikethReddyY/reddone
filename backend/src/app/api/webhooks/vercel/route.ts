import { z } from "zod";

import { createHash } from "node:crypto";

import { verifySha1Webhook } from "@/policy/webhook";
import { getDb } from "@/server/db";
import { isDemoMode } from "@/server/env";
import { markWebhookProcessed, receiveWebhook } from "@/server/webhook-inbox";
import { apiError, ok, requestId } from "@/workflows/http";

const VercelTeamId = z.string().regex(/^team_[A-Za-z0-9_-]+$/);

export async function POST(request: Request) {
  const id = requestId(request);
  const body = await request.text();
  const signature = request.headers.get("x-vercel-signature") ?? request.headers.get("x-vercel-webhook-signature");
  if (!verifySha1Webhook({ body, signature, secret: process.env.VERCEL_WEBHOOK_SECRET ?? process.env.VERCEL_INTEGRATION_CLIENT_SECRET })) {
    return apiError(id, "forbidden", "Invalid Vercel webhook signature.", 403);
  }
  const payload = z
    .object({ id: z.string().optional(), type: z.string(), createdAt: z.number().optional(), payload: z.record(z.string(), z.unknown()).optional() })
    .passthrough()
    .parse(JSON.parse(body));
  if (isDemoMode()) {
    return ok({ accepted: true, provider: "vercel", event: payload.type, delivery: payload.id ?? null, mode: "demo" }, id, { status: 202 });
  }
  if (!payload.id) return apiError(id, "bad_request", "Vercel delivery ID is required.", 400);
  const nested = payload.payload ?? {};
  const team = nested.team as { id?: string } | undefined;
  const parsedTeamId = VercelTeamId.safeParse(team?.id ?? nested.teamId);
  if (!parsedTeamId.success) return apiError(id, "bad_request", "A valid Vercel team ID is required.", 400);
  const teamId = parsedTeamId.data;
  const connections = await getDb().providerConnection.findMany({
    where: { provider: "VERCEL", accountExternalId: teamId },
    select: { id: true, workspaceId: true },
    take: 2,
  });
  if (connections.length !== 1) {
    return apiError(id, "forbidden", "Webhook is not scoped to one connected Vercel account.", 403);
  }
  const connection = connections[0]!;
  const receipt = await receiveWebhook({
    workspaceId: connection.workspaceId,
    consumer: "vercel",
    messageId: payload.id,
    payloadHash: createHash("sha256").update(body).digest("hex"),
  });
  if (!receipt.replayed) {
    const deployment = nested.deployment as { id?: string } | undefined;
    const deploymentId = deployment?.id ?? (typeof nested.deploymentId === "string" ? nested.deploymentId : undefined);
    if (deploymentId) {
      const status = payload.type.includes("error") ? "FAILED" : payload.type.includes("canceled") ? "CANCELED" : null;
      if (status) {
        await getDb().deployment.updateMany({
          where: { workspaceId: connection.workspaceId, externalDeploymentId: deploymentId },
          data: { status },
        });
      }
    }
    if (payload.type.includes("configuration.removed")) {
      await getDb().$transaction(async (tx) => {
        await tx.secretVersion.updateMany({
          where: { workspaceId: connection.workspaceId, providerConnectionId: connection.id, revokedAt: null },
          data: { revokedAt: new Date() },
        });
        await tx.providerConnection.updateMany({
          where: { id: connection.id, health: { not: "REVOKED" } },
          data: {
            health: "REVOKED",
            disconnectedAt: new Date(),
            activeSecretVersionId: null,
            pendingSecretVersionId: null,
            maskedSuffix: null,
            optimisticVersion: { increment: 1 },
          },
        });
      });
    }
    await markWebhookProcessed({ workspaceId: connection.workspaceId, receiptId: receipt.receipt.id });
  }
  return ok({ accepted: true, provider: "vercel", event: payload.type, delivery: payload.id, replayed: receipt.replayed }, id, { status: 202 });
}
