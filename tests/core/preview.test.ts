import { createHash } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import { GET as previewGet } from "@/app/preview/[artifactId]/[token]/[[...path]]/route";
import { signPreviewToken, verifyPreviewToken } from "@/policy/preview-token";
import {
  createDemoPreviewUrl,
  createLivePreviewUrl,
  consumePreviewRequestBudget,
  previewResponseHeaders,
  rewritePreviewAssetPaths,
  validateOutputIndex,
  validatePreviewBuildOutputConfig,
  validateSignedPreviewReport,
  verifyPreviewAccess,
} from "@/server/preview";

const signingKey = "preview-signing-key-with-more-than-thirty-two-bytes";
const artifactHash = "a".repeat(64);
const now = new Date("2026-07-11T02:00:00.000Z");

afterEach(() => vi.unstubAllEnvs());

describe("preview token boundary", () => {
  it("binds a short-lived token to mode, artifact, signature, and expiry", () => {
    const token = signPreviewToken({ mode: "live", artifactId: "artifact-1", artifactHash, key: signingKey, now, ttlSeconds: 900 });
    expect(verifyPreviewToken({ token, key: signingKey, artifactId: "artifact-1", expectedMode: "live", now })).toMatchObject({
      artifactId: "artifact-1",
      artifactHash,
      mode: "live",
    });
    expect(() => verifyPreviewToken({ token, key: signingKey, artifactId: "artifact-2", expectedMode: "live", now })).toThrow();
    expect(() => verifyPreviewToken({ token: `${token.slice(0, -1)}x`, key: signingKey, artifactId: "artifact-1", expectedMode: "live", now })).toThrow();
    expect(() => verifyPreviewToken({ token, key: signingKey, artifactId: "artifact-1", expectedMode: "live", now: new Date("2026-07-11T02:16:00.000Z") })).toThrow(/expired/i);
  });

  it("fails closed in live mode unless both a HTTPS preview origin and signing key exist", () => {
    expect(createLivePreviewUrl({ artifactId: "artifact-1", artifactHash, environment: { DEMO_MODE: "false" }, now })).toBeNull();
    expect(createLivePreviewUrl({ artifactId: "artifact-1", artifactHash, environment: { DEMO_MODE: "false", PREVIEW_ORIGIN: "http://preview.example.test", PREVIEW_SIGNING_KEY: signingKey }, now })).toBeNull();
    expect(createLivePreviewUrl({ artifactId: "artifact-1", artifactHash, environment: { DEMO_MODE: "false", NEXT_PUBLIC_APP_URL: "https://preview.example.test", PREVIEW_ORIGIN: "https://preview.example.test", PREVIEW_SIGNING_KEY: signingKey }, now })).toBeNull();
    const url = createLivePreviewUrl({ artifactId: "artifact-1", artifactHash, environment: { DEMO_MODE: "false", PREVIEW_ORIGIN: "https://preview.example.test", PREVIEW_SIGNING_KEY: signingKey }, now });
    expect(url).toMatch(/^https:\/\/preview\.example\.test\/preview\/artifact-1\//);
    const token = new URL(url!).pathname.split("/")[3]!;
    expect(() => verifyPreviewAccess({ artifactId: "artifact-1", token, requestUrl: url!, environment: { DEMO_MODE: "false", PREVIEW_ORIGIN: "https://wrong.example.test", PREVIEW_SIGNING_KEY: signingKey }, now })).toThrow(/unavailable/i);
  });

  it("serves a real, token-verified, clearly labeled demo route", async () => {
    vi.stubEnv("DEMO_MODE", "true");
    vi.stubEnv("PREVIEW_ORIGIN", "http://preview.local");
    vi.stubEnv("PREVIEW_SIGNING_KEY", signingKey);
    const url = createDemoPreviewUrl({ artifactId: "run-demo-1", artifactHash, environment: process.env });
    expect(url).not.toBeNull();
    const [, , artifactId, token] = new URL(url!).pathname.split("/");
    const response = await previewGet(new Request(url!), { params: Promise.resolve({ artifactId: artifactId!, token: token! }) });
    expect(response.status).toBe(200);
    expect(response.headers.get("x-reddone-preview-mode")).toBe("demo-simulation");
    expect(await response.text()).toContain("Simulation-only preview");

    const rejected = await previewGet(new Request(url!), { params: Promise.resolve({ artifactId: artifactId!, token: `${token}x` }) });
    expect(rejected.status).toBe(404);
  });

  it("bounds repeated requests for one signed URL without retaining the raw token", () => {
    const input = { artifactId: "rate-limited-artifact", token: "rate-limited-token", clientAddress: "203.0.113.10", now };
    for (let request = 0; request < 300; request += 1) expect(consumePreviewRequestBudget(input)).toBe(true);
    expect(consumePreviewRequestBudget(input)).toBe(false);
    expect(consumePreviewRequestBudget({ ...input, now: new Date(now.getTime() + 60_001) })).toBe(true);
  });
});

describe("verified static preview delivery", () => {
  it("recomputes and binds every index entry to the artifact hash", () => {
    const entries = [
      { path: ".vercel/preview-output/config.json", size: 13, sha256: "b".repeat(64) },
      { path: ".vercel/preview-output/static/health.json", size: 17, sha256: "c".repeat(64) },
      { path: ".vercel/preview-output/static/index.html", size: 21, sha256: "d".repeat(64) },
    ];
    const digest = createHash("sha256").update(entries.map((entry) => `${entry.path}\0${entry.size}\0${entry.sha256}`).join("\n")).digest("hex");
    const index = {
      manifest: { schemaVersion: 1, entries, fileCount: entries.length, totalBytes: 51, artifactSha256: digest },
      files: entries.map((entry) => ({ path: entry.path, key: `workspaces/fixture/${entry.sha256}`, sha256: entry.sha256, byteSize: entry.size })),
    };
    expect(validateOutputIndex(Buffer.from(JSON.stringify(index)), digest).get(".vercel/preview-output/static/index.html")?.sha256).toBe("d".repeat(64));
    expect(() => validateOutputIndex(Buffer.from(JSON.stringify({ ...index, files: [{ ...index.files[0], byteSize: 12 }, ...index.files.slice(1)] })), digest)).toThrow(/mismatch/i);
  });

  it("accepts only the pinned static Build Output config and all three signed artifact hashes", () => {
    expect(validatePreviewBuildOutputConfig(Buffer.from('{"version":3,"framework":{"version":"16.2.10"}}'))).toEqual({
      version: 3,
      framework: { version: "16.2.10" },
    });
    expect(() => validatePreviewBuildOutputConfig(Buffer.from('{"version":3,"framework":{"version":"16.2.10"},"routes":[]}'))).toThrow();

    expect(validateSignedPreviewReport({
      sourceArtifactHash: "1".repeat(64),
      artifactHash: "2".repeat(64),
      previewArtifactHash: "3".repeat(64),
    })).toMatchObject({ sourceArtifactHash: "1".repeat(64) });
    expect(() => validateSignedPreviewReport({ artifactHash: "2".repeat(64), previewArtifactHash: "3".repeat(64) })).toThrow();
  });

  it("rewrites only verified static asset paths into the signed route prefix", () => {
    const prefix = "/preview/artifact-1/token-1/";
    const html = Buffer.from('<link href="/_next/app.css"><img src="/generated/logo.png"><script>self.__next_f.push(["/_next/chunk.js"])</script>');
    const rewrittenHtml = rewritePreviewAssetPaths({ body: html, contentType: "text/html; charset=utf-8", prefix }).toString("utf8");
    expect(rewrittenHtml).toContain('href="/preview/artifact-1/token-1/_next/app.css"');
    expect(rewrittenHtml).toContain('src="/preview/artifact-1/token-1/generated/logo.png"');
    expect(rewrittenHtml).toContain('["/preview/artifact-1/token-1/_next/chunk.js"]');

    const rewrittenJs = rewritePreviewAssetPaths({ body: Buffer.from('runtime.p="/_next/"'), contentType: "text/javascript; charset=utf-8", prefix }).toString("utf8");
    expect(rewrittenJs).toBe('runtime.p="/preview/artifact-1/token-1/_next/"');
    const rewrittenCss = rewritePreviewAssetPaths({ body: Buffer.from('background:url("/generated/bg.png")'), contentType: "text/css; charset=utf-8", prefix }).toString("utf8");
    expect(rewrittenCss).toContain("/preview/artifact-1/token-1/generated/bg.png");

    const headers = previewResponseHeaders({ contentType: "text/html; charset=utf-8", html: rewrittenHtml });
    expect(headers["content-security-policy"]).toContain("sha256-");
    expect(headers["content-security-policy"]).not.toContain("script-src 'self' 'unsafe-inline'");
    expect(headers["referrer-policy"]).toBe("no-referrer");
  });
});
