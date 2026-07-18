import { describe, expect, it } from "vitest";

import { normalizeAvatarDataUrl } from "@/server/avatar";

describe("profile avatar normalization", () => {
  it("rejects unsupported or executable image formats", async () => {
    await expect(normalizeAvatarDataUrl("data:image/svg+xml;base64,PHN2Zz48L3N2Zz4="))
      .rejects.toMatchObject({ code: "bad_request" });
  });

  it("rejects images above the compressed upload boundary", async () => {
    const oversized = Buffer.alloc(500_001, 1).toString("base64");
    await expect(normalizeAvatarDataUrl(`data:image/png;base64,${oversized}`))
      .rejects.toMatchObject({ code: "bad_request" });
  });

  it("returns null when the owner removes the image", async () => {
    await expect(normalizeAvatarDataUrl(null)).resolves.toBeNull();
  });
});
