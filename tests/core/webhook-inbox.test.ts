import { Prisma } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  findUniqueOrThrow: vi.fn(),
  updateMany: vi.fn(),
}));

vi.mock("@/server/db", () => ({
  getDb: () => ({
    inboxReceipt: {
      create: mocks.create,
      findUniqueOrThrow: mocks.findUniqueOrThrow,
      updateMany: mocks.updateMany,
    },
  }),
}));

import { receiveWebhook } from "@/server/webhook-inbox";

const input = {
  workspaceId: "11111111-1111-4111-8111-111111111111",
  consumer: "vercel" as const,
  messageId: "delivery-1",
  payloadHash: "a".repeat(64),
};

function duplicateError() {
  return new Prisma.PrismaClientKnownRequestError("Duplicate inbox receipt", {
    code: "P2002",
    clientVersion: "7.8.0",
  });
}

function receipt(overrides: Record<string, unknown> = {}) {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    ...input,
    receivedAt: new Date("2026-07-17T09:00:00.000Z"),
    processingAt: new Date("2026-07-17T09:59:00.000Z"),
    processedAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-07-17T10:00:00.000Z"));
  mocks.create.mockReset();
  mocks.findUniqueOrThrow.mockReset();
  mocks.updateMany.mockReset();
});

afterEach(() => vi.useRealTimers());

describe("webhook inbox processing lease", () => {
  it("accepts the first delivery as the active processor", async () => {
    const created = receipt();
    mocks.create.mockResolvedValue(created);

    await expect(receiveWebhook(input)).resolves.toEqual({ receipt: created, replayed: false });
    expect(mocks.updateMany).not.toHaveBeenCalled();
  });

  it("does not let a concurrent duplicate enter processing", async () => {
    const existing = receipt();
    mocks.create.mockRejectedValue(duplicateError());
    mocks.findUniqueOrThrow.mockResolvedValue(existing);
    mocks.updateMany.mockResolvedValue({ count: 0 });

    await expect(receiveWebhook(input)).resolves.toEqual({ receipt: existing, replayed: true });
  });

  it("reclaims an unfinished delivery only after its lease is stale", async () => {
    const existing = receipt({ processingAt: new Date("2026-07-17T09:40:00.000Z") });
    mocks.create.mockRejectedValue(duplicateError());
    mocks.findUniqueOrThrow.mockResolvedValue(existing);
    mocks.updateMany.mockResolvedValue({ count: 1 });

    await expect(receiveWebhook(input)).resolves.toEqual({ receipt: existing, replayed: false });
    expect(mocks.updateMany).toHaveBeenCalledWith({
      where: {
        id: existing.id,
        workspaceId: input.workspaceId,
        processedAt: null,
        processingAt: { lt: new Date("2026-07-17T09:50:00.000Z") },
      },
      data: { processingAt: new Date("2026-07-17T10:00:00.000Z") },
    });
  });

  it("rejects reuse of a delivery ID with a different payload", async () => {
    mocks.create.mockRejectedValue(duplicateError());
    mocks.findUniqueOrThrow.mockResolvedValue(receipt({ payloadHash: "b".repeat(64) }));

    await expect(receiveWebhook(input)).rejects.toThrow("reused with a different payload");
    expect(mocks.updateMany).not.toHaveBeenCalled();
  });
});
