import { createHash } from "node:crypto";
import path from "node:path";

const editableRoots = ["src/app/generated", "src/components/generated", "src/content", "public/generated"];
const protectedPaths = new Set([
  "package.json",
  "pnpm-lock.yaml",
  "next.config.ts",
  "tsconfig.json",
  "eslint.config.mjs",
  "postcss.config.mjs",
  "vercel.json",
]);
const allowedExtensions = new Set([
  ".ts",
  ".tsx",
  ".css",
  ".json",
  ".md",
  ".mdx",
  ".svg",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".avif",
  ".woff2",
]);

export interface ArtifactFile {
  path: string;
  size: number;
  sha256: string;
}

export interface ArtifactManifest {
  schemaVersion: 1;
  files: ArtifactFile[];
  artifactSha256: string;
}

function normalizeArtifactPath(candidate: string) {
  if (candidate.includes("\\") || candidate.includes("\0") || path.posix.isAbsolute(candidate)) {
    throw new Error("Artifact paths must be normalized relative POSIX paths.");
  }
  const normalized = path.posix.normalize(candidate);
  if (normalized === "." || normalized.startsWith("../") || normalized.includes("/../")) {
    throw new Error("Artifact path traversal was rejected.");
  }
  return normalized;
}

export function assertEditableArtifactPath(candidate: string) {
  const normalized = normalizeArtifactPath(candidate);
  if (protectedPaths.has(normalized) || normalized.startsWith(".github/") || normalized.startsWith(".vercel/")) {
    throw new Error(`Protected path rejected: ${normalized}`);
  }
  if (!editableRoots.some((root) => normalized === root || normalized.startsWith(`${root}/`))) {
    throw new Error(`Path is outside the generated-code allowlist: ${normalized}`);
  }
  if (!allowedExtensions.has(path.posix.extname(normalized).toLowerCase())) {
    throw new Error(`Unsupported generated file type: ${normalized}`);
  }
  return normalized;
}

export function buildArtifactManifest(files: Array<{ path: string; content: Uint8Array }>): ArtifactManifest {
  if (files.length === 0 || files.length > 2_000) throw new Error("Artifact file count is outside policy.");
  let totalBytes = 0;
  const seen = new Set<string>();
  const manifestFiles = files
    .map(({ path: filePath, content }) => {
      const normalized = assertEditableArtifactPath(filePath);
      if (seen.has(normalized)) throw new Error(`Duplicate artifact path: ${normalized}`);
      seen.add(normalized);
      if (content.byteLength > 5 * 1024 * 1024) throw new Error(`Generated file exceeds 5 MiB: ${normalized}`);
      totalBytes += content.byteLength;
      return {
        path: normalized,
        size: content.byteLength,
        sha256: createHash("sha256").update(content).digest("hex"),
      };
    })
    .sort((a, b) => a.path.localeCompare(b.path));
  if (totalBytes > 25 * 1024 * 1024) throw new Error("Artifact exceeds the 25 MiB generated-content limit.");
  const canonical = manifestFiles.map((file) => `${file.path}\0${file.size}\0${file.sha256}`).join("\n");
  return {
    schemaVersion: 1,
    files: manifestFiles,
    artifactSha256: createHash("sha256").update(canonical).digest("hex"),
  };
}

export function verifyArtifactManifest(manifest: ArtifactManifest, files: Array<{ path: string; content: Uint8Array }>) {
  const rebuilt = buildArtifactManifest(files);
  if (rebuilt.artifactSha256 !== manifest.artifactSha256) throw new Error("Artifact hash mismatch.");
  if (JSON.stringify(rebuilt.files) !== JSON.stringify(manifest.files)) throw new Error("Artifact manifest mismatch.");
  return rebuilt;
}
