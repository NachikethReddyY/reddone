import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";

import { GET as getAccount, PATCH as patchAccount } from "@/app/api/v1/account/route";
import { PUT as putAvatar } from "@/app/api/v1/account/avatar/route";
import { GET as getSessions } from "@/app/api/v1/account/sessions/route";
import { AccountProfileResponseSchema, AccountSessionListResponseSchema } from "@/contracts/account";

describe("account API contracts", () => {
  beforeEach(() => vi.stubEnv("APP_MODE", "demo"));
  afterEach(() => vi.unstubAllEnvs());

  it("returns strict demo-safe profile and session records without tokens", async () => {
    const profileResponse = await getAccount(new Request("https://console.example.test/api/v1/account"));
    const sessionResponse = await getSessions(new Request("https://console.example.test/api/v1/account/sessions"));
    const profile = AccountProfileResponseSchema.parse(await profileResponse.json());
    const sessions = AccountSessionListResponseSchema.parse(await sessionResponse.json());

    expect(profile.data.user.email).toBe("owner@demo.invalid");
    expect(profile.data.user.image).toBeNull();
    expect(sessions.data.items[0]?.current).toBe(true);
    expect(JSON.stringify(sessions)).not.toContain("token");
  });

  it("validates and returns account updates through the standard response envelope", async () => {
    const response = await patchAccount(new Request("https://console.example.test/api/v1/account", {
      method: "PATCH",
      headers: { "content-type": "application/json", "idempotency-key": "account-test-update" },
      body: JSON.stringify({ workspaceName: "Updated demo", timeZone: "Europe/Paris" }),
    }));
    const payload = AccountProfileResponseSchema.parse(await response.json());

    expect(response.status).toBe(200);
    expect(payload.data.workspace).toMatchObject({ name: "Updated demo", timeZone: "Europe/Paris" });
  });

  it("normalizes uploaded profile images into bounded WebP database values", async () => {
    const source = await sharp({
      create: { width: 900, height: 600, channels: 3, background: "#ff4f18" },
    }).png().toBuffer();
    const response = await putAvatar(new Request("https://console.example.test/api/v1/account/avatar", {
      method: "PUT",
      headers: { "content-type": "application/json", "idempotency-key": "account-avatar-upload" },
      body: JSON.stringify({ image: `data:image/png;base64,${source.toString("base64")}` }),
    }));
    const payload = AccountProfileResponseSchema.parse(await response.json());
    const image = payload.data.user.image;

    expect(response.status).toBe(200);
    expect(image).toMatch(/^data:image\/webp;base64,/);
    const output = Buffer.from(image!.split(",")[1]!, "base64");
    const metadata = await sharp(output).metadata();
    expect(metadata).toMatchObject({ format: "webp", width: 256, height: 256 });
    expect(output.byteLength).toBeLessThanOrEqual(120_000);
  });

  it("supports removing a profile image", async () => {
    const response = await putAvatar(new Request("https://console.example.test/api/v1/account/avatar", {
      method: "PUT",
      headers: { "content-type": "application/json", "idempotency-key": "account-avatar-remove" },
      body: JSON.stringify({ image: null }),
    }));
    const payload = AccountProfileResponseSchema.parse(await response.json());

    expect(response.status).toBe(200);
    expect(payload.data.user.image).toBeNull();
  });
});
