import "server-only";

import { createHash } from "node:crypto";
import path from "node:path";

import { z } from "zod";

import { getVerifiedArtifact } from "@/integrations/artifact-store";
import { getDeploymentMode } from "@/server/env";
import { signPreviewToken, verifyPreviewToken, type PreviewTokenPayload } from "@/policy/preview-token";
import { getDb } from "@/server/db";
import { verifySignedVerificationReport } from "@/server/security/verification-signature";

const DEMO_PREVIEW_KEY = "reddone-demo-preview-key-is-public-and-not-for-live-use";
const PREVIEW_TTL_SECONDS = 15 * 60;
const MAX_INDEX_BYTES = 5 * 1024 * 1024;
const MAX_PREVIEW_FILE_BYTES = 10 * 1024 * 1024;
const PREVIEW_RATE_WINDOW_MS = 60_000;
const PREVIEW_RATE_LIMIT = 300;
const MAX_RATE_LIMIT_KEYS = 5_000;

const previewRateLimits = new Map<string, { count: number; resetAt: number }>();

const OutputPathSchema = z
  .string()
  .trim()
  .min(1)
  .max(1_024)
  .refine((value) => !value.includes("\\") && !value.includes("\0") && !path.posix.isAbsolute(value) && !value.split("/").includes(".."), {
    message: "Output path is invalid",
  });

const OutputIndexSchema = z
  .object({
    manifest: z
      .object({
        schemaVersion: z.literal(1),
        entries: z.array(z.object({ path: OutputPathSchema, size: z.number().int().nonnegative().max(MAX_PREVIEW_FILE_BYTES), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict()).min(1).max(5_000),
        fileCount: z.number().int().positive().max(5_000),
        totalBytes: z.number().int().positive().max(100 * 1024 * 1024),
        artifactSha256: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict(),
    files: z.array(z.object({ path: OutputPathSchema, key: z.string().startsWith("workspaces/").max(1_024), sha256: z.string().regex(/^[a-f0-9]{64}$/), byteSize: z.number().int().nonnegative().max(MAX_PREVIEW_FILE_BYTES) }).strict()).min(1).max(5_000),
  })
  .strict();

const PreviewBuildOutputConfigSchema = z
  .object({
    version: z.literal(3),
    framework: z.object({ version: z.literal("16.2.10") }).strict(),
  })
  .strict();

const SignedPreviewReportSchema = z
  .object({
    sourceArtifactHash: z.string().regex(/^[a-f0-9]{64}$/),
    artifactHash: z.string().regex(/^[a-f0-9]{64}$/),
    previewArtifactHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .passthrough();

const mediaTypes = new Map([
  [".avif", "image/avif"],
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".txt", "text/plain; charset=utf-8"],
  [".webp", "image/webp"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
]);

type PreviewEnvironment = Readonly<Record<string, string | undefined>>;

function normalizedOrigin(raw: string | undefined, live: boolean) {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) return null;
    if (live && url.protocol !== "https:") return null;
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

function previewConfiguration(mode: PreviewTokenPayload["mode"], environment: PreviewEnvironment = process.env) {
  if (mode === "live") {
    const origin = normalizedOrigin(environment.PREVIEW_ORIGIN, true);
    const key = environment.PREVIEW_SIGNING_KEY;
    const applicationOrigins = [environment.NEXT_PUBLIC_APP_URL, environment.AUTH_TRUSTED_ORIGIN]
      .map((value) => normalizedOrigin(value, false))
      .filter((value): value is string => Boolean(value));
    return origin && !applicationOrigins.includes(origin) && key && Buffer.byteLength(key) >= 32 ? { origin, key } : null;
  }
  const origin = normalizedOrigin(environment.PREVIEW_ORIGIN ?? environment.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000", false);
  if (!origin) return null;
  const configuredKey = environment.PREVIEW_SIGNING_KEY;
  return { origin, key: configuredKey && Buffer.byteLength(configuredKey) >= 32 ? configuredKey : DEMO_PREVIEW_KEY };
}

function previewUrl(input: {
  mode: PreviewTokenPayload["mode"];
  artifactId: string;
  artifactHash: string;
  environment?: PreviewEnvironment;
  now?: Date;
}) {
  const configuration = previewConfiguration(input.mode, input.environment);
  if (!configuration) return null;
  const token = signPreviewToken({
    mode: input.mode,
    artifactId: input.artifactId,
    artifactHash: input.artifactHash,
    key: configuration.key,
    ttlSeconds: PREVIEW_TTL_SECONDS,
    ...(input.now ? { now: input.now } : {}),
  });
  return `${configuration.origin}/preview/${encodeURIComponent(input.artifactId)}/${encodeURIComponent(token)}/`;
}

export function createLivePreviewUrl(input: { artifactId: string; artifactHash: string; environment?: PreviewEnvironment; now?: Date }) {
  return previewUrl({ mode: "live", ...input });
}

export function createDemoPreviewUrl(input: { artifactId: string; artifactHash: string; environment?: PreviewEnvironment; now?: Date }) {
  return previewUrl({ mode: "demo", ...input });
}

export function verifyPreviewAccess(input: {
  artifactId: string;
  token: string;
  requestUrl: string;
  environment?: PreviewEnvironment;
  now?: Date;
}) {
  const environment = input.environment ?? process.env;
  const liveMode = getDeploymentMode(environment) !== "demo";
  const mode: PreviewTokenPayload["mode"] = liveMode ? "live" : "demo";
  const configuration = previewConfiguration(mode, environment);
  if (!configuration || new URL(input.requestUrl).origin !== configuration.origin) {
    throw new Error("Preview is unavailable.");
  }
  const payload = verifyPreviewToken({
    token: input.token,
    key: configuration.key,
    artifactId: input.artifactId,
    expectedMode: mode,
    ...(input.now ? { now: input.now } : {}),
  });
  return { payload, origin: configuration.origin };
}

/** Best-effort per-instance guard; production must also rate-limit the preview hostname at the edge. */
export function consumePreviewRequestBudget(input: { artifactId: string; token: string; clientAddress?: string; now?: Date }) {
  const current = (input.now ?? new Date()).getTime();
  if (previewRateLimits.size >= MAX_RATE_LIMIT_KEYS) {
    for (const [key, value] of previewRateLimits) {
      if (value.resetAt <= current) previewRateLimits.delete(key);
    }
    if (previewRateLimits.size >= MAX_RATE_LIMIT_KEYS) previewRateLimits.delete(previewRateLimits.keys().next().value!);
  }
  const key = createHash("sha256")
    .update(`${input.artifactId}\0${input.token}\0${input.clientAddress ?? "unknown"}`)
    .digest("hex");
  const existing = previewRateLimits.get(key);
  if (!existing || existing.resetAt <= current) {
    previewRateLimits.set(key, { count: 1, resetAt: current + PREVIEW_RATE_WINDOW_MS });
    return true;
  }
  if (existing.count >= PREVIEW_RATE_LIMIT) return false;
  existing.count += 1;
  return true;
}

export function validatePreviewBuildOutputConfig(raw: Uint8Array) {
  return PreviewBuildOutputConfigSchema.parse(JSON.parse(Buffer.from(raw).toString("utf8")));
}

export function validateSignedPreviewReport(report: unknown) {
  return SignedPreviewReportSchema.parse(report);
}

export function validateOutputIndex(raw: Uint8Array, expectedArtifactHash: string) {
  const index = OutputIndexSchema.parse(JSON.parse(Buffer.from(raw).toString("utf8")));
  if (index.manifest.fileCount !== index.manifest.entries.length || index.files.length !== index.manifest.entries.length) {
    throw new Error("Preview artifact index count mismatch.");
  }
  const entries = [...index.manifest.entries].sort((left, right) => left.path.localeCompare(right.path));
  const entryPaths = new Set<string>();
  const files = new Map<string, (typeof index.files)[number]>();
  for (const file of index.files) {
    if (files.has(file.path)) throw new Error("Preview artifact index contains a duplicate path.");
    files.set(file.path, file);
  }
  let totalBytes = 0;
  for (const entry of entries) {
    if (entryPaths.has(entry.path)) throw new Error("Preview artifact index contains a duplicate manifest path.");
    entryPaths.add(entry.path);
    if (
      entry.path !== ".vercel/preview-output/config.json" &&
      !entry.path.startsWith(".vercel/preview-output/static/")
    ) {
      throw new Error("Preview artifact contains a path outside the static output root.");
    }
    const file = files.get(entry.path);
    if (!file || file.sha256 !== entry.sha256 || file.byteSize !== entry.size) {
      throw new Error("Preview artifact index file mismatch.");
    }
    totalBytes += entry.size;
  }
  const artifactHash = createHash("sha256")
    .update(entries.map((entry) => `${entry.path}\0${entry.size}\0${entry.sha256}`).join("\n"))
    .digest("hex");
  if (totalBytes !== index.manifest.totalBytes || artifactHash !== index.manifest.artifactSha256 || artifactHash !== expectedArtifactHash) {
    throw new Error("Preview artifact manifest integrity check failed.");
  }
  for (const required of [
    ".vercel/preview-output/config.json",
    ".vercel/preview-output/static/index.html",
    ".vercel/preview-output/static/health.json",
  ]) {
    if (!entryPaths.has(required)) throw new Error(`Preview artifact is missing ${required}.`);
  }
  for (const entry of entries) {
    if (entry.path === ".vercel/preview-output/config.json") continue;
    if (!mediaTypes.has(path.posix.extname(entry.path).toLowerCase())) {
      throw new Error("Preview artifact contains an unsupported static file type.");
    }
  }
  return files;
}

function requestedStaticPath(segments: string[] | undefined) {
  const values = segments?.length ? segments : ["index.html"];
  if (values.some((segment) => !segment || segment === "." || segment === ".." || segment.includes("/") || segment.includes("\\") || segment.includes("\0"))) {
    throw new Error("Preview path is invalid.");
  }
  let relative = values.join("/");
  if (relative.endsWith("/")) relative += "index.html";
  if (relative.length > 1_000) throw new Error("Preview path is invalid.");
  return `.vercel/preview-output/static/${relative}`;
}

function rewriteKnownAssetPrefixes(value: string, prefix: string) {
  return value
    .replace(/(["'`])\/(?:_next)\//g, `$1${prefix}_next/`)
    .replace(/(["'`])\/(?:generated)\//g, `$1${prefix}generated/`);
}

function rewriteHtml(value: string, prefix: string) {
  const attributes = value.replace(/\b(src|href|poster|action)=(["'])\/(?!\/)([^"']*)/gi, (_match, attribute: string, quote: string, target: string) => `${attribute}=${quote}${prefix}${target}`);
  const sourceSets = attributes.replace(/\bsrcset=(["'])([^"']*)\1/gi, (_match, quote: string, content: string) => {
    const rewritten = content.split(",").map((candidate) => {
      const [url, ...descriptor] = candidate.trim().split(/\s+/);
      return `${url?.startsWith("/") && !url.startsWith("//") ? `${prefix}${url.slice(1)}` : url}${descriptor.length ? ` ${descriptor.join(" ")}` : ""}`;
    }).join(", ");
    return `srcset=${quote}${rewritten}${quote}`;
  });
  return rewriteKnownAssetPrefixes(sourceSets, prefix);
}

function rewriteCss(value: string, prefix: string) {
  return value.replace(/url\(\s*(["']?)\/(?!\/)([^)"']+)\1\s*\)/gi, (_match, quote: string, target: string) => `url(${quote}${prefix}${target}${quote})`);
}

export function rewritePreviewAssetPaths(input: { body: Uint8Array; contentType: string; prefix: string }) {
  if (!/^\/preview\/[A-Za-z0-9%._~-]+\/[A-Za-z0-9%._~-]+\/$/.test(input.prefix)) throw new Error("Preview prefix is invalid.");
  const source = Buffer.from(input.body).toString("utf8");
  if (input.contentType.startsWith("text/html")) return Buffer.from(rewriteHtml(source, input.prefix), "utf8");
  if (input.contentType.startsWith("text/css")) return Buffer.from(rewriteCss(source, input.prefix), "utf8");
  if (input.contentType.startsWith("text/javascript") || input.contentType.startsWith("text/plain")) {
    return Buffer.from(rewriteKnownAssetPrefixes(source, input.prefix), "utf8");
  }
  return Buffer.from(input.body);
}

function inlineScriptHashes(html: string) {
  const hashes = new Set<string>();
  for (const match of html.matchAll(/<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)) {
    if (match[1]) hashes.add(`'sha256-${createHash("sha256").update(match[1]).digest("base64")}'`);
  }
  return [...hashes];
}

export function previewResponseHeaders(input: { contentType: string; html?: string; sourceSha256?: string }) {
  const scriptHashes = input.html ? inlineScriptHashes(input.html) : [];
  const contentSecurityPolicy = input.contentType.startsWith("text/html")
    ? [
        "default-src 'none'",
        `script-src 'self'${scriptHashes.length ? ` ${scriptHashes.join(" ")}` : ""}`,
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data:",
        "font-src 'self'",
        "connect-src 'none'",
        "object-src 'none'",
        "frame-src 'none'",
        "worker-src 'none'",
        "base-uri 'none'",
        "form-action 'none'",
        "frame-ancestors 'none'",
        "manifest-src 'self'",
      ].join("; ")
    : "default-src 'none'; sandbox";
  return {
    "cache-control": "private, no-store, max-age=0",
    "content-security-policy": contentSecurityPolicy,
    "content-type": input.contentType,
    "cross-origin-opener-policy": "same-origin",
    "cross-origin-resource-policy": "same-origin",
    "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "x-robots-tag": "noindex, nofollow, noarchive",
    ...(input.sourceSha256 ? { "x-reddone-source-sha256": input.sourceSha256 } : {}),
  };
}

export function demoPreviewDocument(payload: PreviewTokenPayload) {
  const expiresAt = new Date(payload.expiresAt * 1_000).toISOString();
  const artifact = payload.artifactHash.slice(0, 12);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ReDDone demo preview</title><style>color-scheme:dark;*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#071018;color:#f2f7fa;font:17px/1.5 system-ui,sans-serif}.card{width:min(720px,calc(100% - 32px));padding:34px;border:1px solid #203543;background:#0d1923}.tag{display:inline-block;padding:5px 9px;background:#002e41;color:#00bbff;font:700 12px/1.2 ui-monospace,monospace;text-transform:uppercase}h1{font-size:clamp(32px,7vw,62px);line-height:1;margin:24px 0 18px}p{color:#a9bac5}dl{display:grid;gap:8px;margin-top:28px}div{overflow-wrap:anywhere}dt{color:#748a98;font-size:12px;text-transform:uppercase}dd{margin:2px 0 0;font-family:ui-monospace,monospace}</style></head><body><main class="card"><span class="tag">Simulation-only preview</span><h1>Verified preview route is working.</h1><p>This demo page proves token validation and expiry handling. It does not execute or imitate a generated production artifact.</p><dl><div><dt>Artifact</dt><dd>${artifact}…</dd></div><div><dt>Expires</dt><dd>${expiresAt}</dd></div></dl></main></body></html>`;
}

export async function loadVerifiedPreviewFile(input: {
  artifactId: string;
  artifactHash: string;
  pathSegments?: string[];
}) {
  const db = getDb();
  const artifact = await db.buildArtifact.findFirst({
    where: { id: input.artifactId, artifactHash: input.artifactHash, kind: "PREVIEW_STATIC" },
  });
  const [releaseArtifact, sourceArtifact] = artifact
    ? await Promise.all([
        db.buildArtifact.findFirst({
          where: {
            workspaceId: artifact.workspaceId,
            projectId: artifact.projectId,
            runId: artifact.runId,
            kind: "VERCEL_OUTPUT",
          },
          include: { verification: true },
        }),
        db.buildArtifact.findFirst({
          where: {
            workspaceId: artifact.workspaceId,
            projectId: artifact.projectId,
            runId: artifact.runId,
            kind: "VERIFIED_SOURCE",
          },
        }),
      ])
    : [null, null];
  const verification = releaseArtifact?.verification;
  const verificationKey = process.env.VERIFICATION_SIGNING_KEY ?? process.env.BETTER_AUTH_SECRET;
  const signedReport = SignedPreviewReportSchema.safeParse(verification?.report);
  if (
    !artifact ||
    (artifact.expiresAt && artifact.expiresAt <= new Date()) ||
    !releaseArtifact ||
    !sourceArtifact ||
    !verification ||
    verification.status !== "PASSED" ||
    !verification.verifiedAt ||
    (verification.expiresAt && verification.expiresAt <= new Date()) ||
    !signedReport.success ||
    signedReport.data.sourceArtifactHash !== sourceArtifact.artifactHash ||
    signedReport.data.artifactHash !== releaseArtifact.artifactHash ||
    signedReport.data.previewArtifactHash !== artifact.artifactHash ||
    !verifySignedVerificationReport({ report: verification.report, reportHash: verification.reportHash, signature: verification.signature, key: verificationKey })
  ) {
    throw new Error("Verified preview artifact is unavailable.");
  }
  const rawIndex = await getVerifiedArtifact(artifact.objectKey, artifact.manifestHash, MAX_INDEX_BYTES);
  const files = validateOutputIndex(rawIndex, artifact.artifactHash);
  const config = files.get(".vercel/preview-output/config.json");
  if (!config) throw new Error("Preview Build Output configuration is unavailable.");
  const configBody = await getVerifiedArtifact(config.key, config.sha256, MAX_PREVIEW_FILE_BYTES);
  if (configBody.byteLength !== config.byteSize) throw new Error("Preview Build Output configuration size mismatch.");
  validatePreviewBuildOutputConfig(configBody);
  const selectedPath = requestedStaticPath(input.pathSegments);
  const selected = files.get(selectedPath);
  if (!selected || !selectedPath.startsWith(".vercel/preview-output/static/")) throw new Error("Preview file was not found.");
  const extension = path.posix.extname(selectedPath).toLowerCase();
  const contentType = mediaTypes.get(extension);
  if (!contentType) throw new Error("Preview file type is not allowed.");
  const body = await getVerifiedArtifact(selected.key, selected.sha256, MAX_PREVIEW_FILE_BYTES);
  if (body.byteLength !== selected.byteSize) throw new Error("Preview file size mismatch.");
  return { body, contentType, sourceSha256: selected.sha256 };
}
