import { afterEach, describe, expect, it, vi } from "vitest";

import { createGcpV4SignedArtifactUrl } from "@/server/security/gcp-storage-signing";

afterEach(() => vi.unstubAllGlobals());

describe("GCP V4 artifact URL signing", () => {
  it("applies the create-only generation precondition to uploads but not downloads", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      signedBlob: Buffer.from("signature", "utf8").toString("base64"),
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const shared = {
      authClient: { getAccessToken: async () => ({ token: "access-token" }) },
      signerServiceAccount: "reddone-signer@example.iam.gserviceaccount.com",
      bucket: "reddone-artifacts",
      objectKey: "artifacts/run-1/report.json",
      expiresInSeconds: 300,
      now: new Date("2026-07-16T12:00:00.000Z"),
    };

    const download = new URL(await createGcpV4SignedArtifactUrl({ ...shared, method: "GET" }));
    const upload = new URL(await createGcpV4SignedArtifactUrl({ ...shared, method: "PUT" }));

    expect(download.searchParams.has("ifGenerationMatch")).toBe(false);
    expect(upload.searchParams.get("ifGenerationMatch")).toBe("0");
    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ headers: expect.objectContaining({ authorization: "Bearer access-token" }) }),
    );
  });
});
