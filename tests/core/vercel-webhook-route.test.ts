import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  verify: vi.fn(),
  isDemoMode: vi.fn(),
  findConnections: vi.fn(),
  receiveWebhook: vi.fn(),
  markWebhookProcessed: vi.fn(),
  updateDeployments: vi.fn(),
  transaction: vi.fn(),
  revokeSecrets: vi.fn(),
  revokeConnection: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/policy/webhook", () => ({ verifySha1Webhook: mocks.verify }));
vi.mock("@/server/env", () => ({ isDemoMode: mocks.isDemoMode }));
vi.mock("@/server/db", () => ({
  getDb: () => ({
    providerConnection: { findMany: mocks.findConnections },
    deployment: { updateMany: mocks.updateDeployments },
    $transaction: mocks.transaction,
  }),
}));
vi.mock("@/server/webhook-inbox", () => ({
  receiveWebhook: mocks.receiveWebhook,
  markWebhookProcessed: mocks.markWebhookProcessed,
}));

import { POST } from "@/app/api/webhooks/vercel/route";

function vercelWebhook(payload: unknown): Request {
  return new Request("https://console.example.test/api/webhooks/vercel", {
    method: "POST",
    headers: { "x-vercel-signature": "signed", "x-request-id": "request-1" },
    body: JSON.stringify(payload),
  });
}

describe("Vercel webhook route tenant isolation", () => {
  beforeEach(() => {
    mocks.verify.mockReset();
    mocks.isDemoMode.mockReset();
    mocks.findConnections.mockReset();
    mocks.receiveWebhook.mockReset();
    mocks.markWebhookProcessed.mockReset();
    mocks.updateDeployments.mockReset();
    mocks.transaction.mockReset();
    mocks.revokeSecrets.mockReset();
    mocks.revokeConnection.mockReset();

    mocks.verify.mockReturnValue(true);
    mocks.isDemoMode.mockReturnValue(false);
    mocks.receiveWebhook.mockResolvedValue({ receipt: { id: "receipt-1" }, replayed: false });
    mocks.markWebhookProcessed.mockResolvedValue(undefined);
    mocks.revokeSecrets.mockResolvedValue({ count: 1 });
    mocks.revokeConnection.mockResolvedValue({ count: 1 });
    mocks.transaction.mockImplementation(async (operation) => operation({
      secretVersion: { updateMany: mocks.revokeSecrets },
      providerConnection: { updateMany: mocks.revokeConnection },
    }));
  });

  it("rejects a missing or invalid team ID before connection lookup or receipt", async () => {
    for (const payload of [
      { id: "delivery-missing", type: "deployment.created", payload: {} },
      { id: "delivery-invalid", type: "deployment.created", payload: { team: { id: "user_not-a-team" } } },
    ]) {
      const response = await POST(vercelWebhook(payload));
      expect(response.status).toBe(400);
    }

    expect(mocks.findConnections).not.toHaveBeenCalled();
    expect(mocks.receiveWebhook).not.toHaveBeenCalled();
    expect(mocks.markWebhookProcessed).not.toHaveBeenCalled();
  });

  it("requires the exact Vercel provider and account ID before receiving the webhook", async () => {
    const connection = { id: "connection-1", workspaceId: "workspace-1" };
    mocks.findConnections.mockImplementation(async ({ where }) => (
      where.provider === "VERCEL" && where.accountExternalId === "team_connected" ? [connection] : []
    ));

    const mismatched = await POST(vercelWebhook({
      id: "delivery-other",
      type: "deployment.created",
      payload: { team: { id: "team_other" } },
    }));
    expect(mismatched.status).toBe(403);
    expect(mocks.receiveWebhook).not.toHaveBeenCalled();

    const matched = await POST(vercelWebhook({
      id: "delivery-connected",
      type: "deployment.created",
      payload: { team: { id: "team_connected" } },
    }));
    expect(matched.status).toBe(202);
    expect(mocks.findConnections).toHaveBeenLastCalledWith({
      where: { provider: "VERCEL", accountExternalId: "team_connected" },
      select: { id: true, workspaceId: true },
      take: 2,
    });
    expect(mocks.receiveWebhook).toHaveBeenCalledTimes(1);
    expect(mocks.receiveWebhook).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      consumer: "vercel",
      messageId: "delivery-connected",
      payloadHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(mocks.markWebhookProcessed).toHaveBeenCalledWith({ workspaceId: "workspace-1", receiptId: "receipt-1" });
  });

  it("fails closed when a Vercel team matches more than one workspace", async () => {
    mocks.findConnections.mockResolvedValue([
      { id: "connection-1", workspaceId: "workspace-1" },
      { id: "connection-2", workspaceId: "workspace-2" },
    ]);

    const response = await POST(vercelWebhook({
      id: "delivery-ambiguous",
      type: "deployment.created",
      payload: { team: { id: "team_shared" } },
    }));

    expect(response.status).toBe(403);
    expect(mocks.receiveWebhook).not.toHaveBeenCalled();
    expect(mocks.updateDeployments).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.markWebhookProcessed).not.toHaveBeenCalled();
  });

  it("makes configuration removal idempotent before marking the receipt processed", async () => {
    mocks.findConnections.mockResolvedValue([{ id: "connection-1", workspaceId: "workspace-1" }]);

    const response = await POST(vercelWebhook({
      id: "delivery-removed",
      type: "integration-configuration.removed",
      payload: { team: { id: "team_connected" } },
    }));

    expect(response.status).toBe(202);
    expect(mocks.revokeSecrets).toHaveBeenCalledWith({
      where: { workspaceId: "workspace-1", providerConnectionId: "connection-1", revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
    expect(mocks.revokeConnection).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "connection-1", health: { not: "REVOKED" } },
      data: expect.objectContaining({ optimisticVersion: { increment: 1 } }),
    }));
    expect(mocks.markWebhookProcessed).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      receiptId: "receipt-1",
    });
  });
});
