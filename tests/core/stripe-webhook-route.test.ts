import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  verify: vi.fn(),
  process: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/integrations/stripe", () => ({ verifyStripeWebhook: mocks.verify }));
vi.mock("@/server/billing", () => ({ processStripeEvent: mocks.process }));

import { POST } from "@/app/api/webhooks/stripe/route";

describe("Stripe webhook route", () => {
  beforeEach(() => {
    mocks.verify.mockReset();
    mocks.process.mockReset();
  });

  it("passes the exact raw body and signature to verification before processing", async () => {
    const rawBody = '{"id":"evt_raw","data":{"object":{"note":"spacing matters"}}}';
    const event = { id: "evt_raw", type: "checkout.session.completed" };
    mocks.verify.mockReturnValue(event);
    mocks.process.mockResolvedValue({ duplicate: false, handled: true, workspaceId: "workspace-1" });

    const response = await POST(new Request("https://console.example.test/api/webhooks/stripe", {
      method: "POST",
      headers: { "stripe-signature": "t=123,v1=signed", "x-request-id": "request-1" },
      body: rawBody,
    }));

    expect(mocks.verify).toHaveBeenCalledWith(rawBody, "t=123,v1=signed");
    expect(mocks.process).toHaveBeenCalledWith(event);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      data: { received: true, duplicate: false, handled: true },
      requestId: "request-1",
    });
  });

  it("acknowledges an identical duplicate without a second local grant response", async () => {
    mocks.verify.mockReturnValue({ id: "evt_duplicate", type: "invoice.paid" });
    mocks.process.mockResolvedValue({ duplicate: true, handled: true, workspaceId: "workspace-1" });
    const response = await POST(new Request("https://console.example.test/api/webhooks/stripe", {
      method: "POST",
      headers: { "stripe-signature": "t=123,v1=signed" },
      body: "{}",
    }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ data: { duplicate: true, handled: true } });
  });
});
