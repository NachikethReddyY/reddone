import "server-only";

import { createHash } from "node:crypto";
import path from "node:path";

import { Daytona, type FileInfo, type Sandbox } from "@daytona/sdk";

import { assertEditableArtifactPath } from "@/policy/build-boundary";
import { IntegrationError } from "./errors";

export type SandboxPurpose = "builder" | "verifier";

export interface SandboxHandle {
  id: string;
  purpose: SandboxPurpose;
  readFile: (path: string) => Promise<Buffer>;
  writeGeneratedFile: (path: string, content: Buffer) => Promise<void>;
  listGeneratedFiles: () => Promise<string[]>;
  listRepositoryFiles: () => Promise<string[]>;
  listVerifierOutputFiles: () => Promise<string[]>;
  readVerifierOutputFile: (path: string) => Promise<Buffer>;
  listPreviewOutputFiles: () => Promise<string[]>;
  readPreviewOutputFile: (path: string) => Promise<Buffer>;
  searchText: (query: string) => Promise<Array<{ file: string; line?: number; content?: string }>>;
  runVerifierGate: (gate: VerifierGate) => Promise<{ gate: VerifierGate; exitCode: number; output: string }>;
  destroy: () => Promise<void>;
}

export const verifierGates = [
  "manifest",
  "secret_scan",
  "dependency_audit",
  "license_audit",
  "sast",
  "typecheck",
  "lint",
  "unit_tests",
  "production_build",
  "playwright",
] as const;
export type VerifierGate = (typeof verifierGates)[number];

const trustedVerifierCommands: Record<VerifierGate, string> = {
  manifest: "/opt/reddone/verify/run-gate manifest",
  secret_scan: "/opt/reddone/verify/run-gate secret-scan",
  dependency_audit: "/opt/reddone/verify/run-gate dependency-audit",
  license_audit: "/opt/reddone/verify/run-gate license-audit",
  sast: "/opt/reddone/verify/run-gate sast",
  typecheck: "/opt/reddone/verify/run-gate typecheck",
  lint: "/opt/reddone/verify/run-gate lint",
  unit_tests: "/opt/reddone/verify/run-gate unit-tests",
  playwright: "/opt/reddone/verify/run-gate playwright",
  production_build: "/opt/reddone/verify/run-gate production-build",
};
const trustedExportAssertion = "/opt/reddone/verify/assert-export";

function assertReadablePath(candidate: string) {
  if (!candidate || candidate.startsWith("/") || candidate.includes("\\") || candidate.split("/").includes("..")) {
    throw new Error("Read path is outside the workspace.");
  }
  if (
    !(
      candidate.startsWith("src/") ||
      candidate.startsWith("public/") ||
      candidate.startsWith("tests/") ||
      [
        "package.json",
        "pnpm-lock.yaml",
        "tsconfig.json",
        "next.config.ts",
        "eslint.config.mjs",
        "playwright.config.ts",
        "vitest.config.ts",
        "vercel.json",
        "next-env.d.ts",
      ].includes(candidate)
    )
  ) {
    throw new Error("Read path is outside the starter allowlist.");
  }
  return candidate;
}

function assertVerifierOutputPath(candidate: string) {
  if (!candidate.startsWith(".vercel/output/") || candidate.includes("\\") || candidate.split("/").includes("..")) {
    throw new Error("Verifier output path is invalid.");
  }
  return candidate;
}

function assertPreviewOutputPath(candidate: string) {
  if (!candidate.startsWith(".vercel/preview-output/") || candidate.includes("\\") || candidate.split("/").includes("..")) {
    throw new Error("Static preview output path is invalid.");
  }
  return candidate;
}

function assertGeneratedSandboxPath(candidate: string) {
  const normalized = assertEditableArtifactPath(candidate);
  const segments = normalized.split("/");
  if (segments.some((segment) => segment === "node_modules" || segment.startsWith("."))) {
    throw new Error("Generated paths cannot create hidden or package-resolution directories.");
  }
  if (segments.at(-1)?.toLowerCase() === "package.json") {
    throw new Error("Generated paths cannot introduce a package boundary.");
  }
  const extension = path.posix.extname(normalized).toLowerCase();
  if (normalized.startsWith("src/app/generated/") && extension !== ".css") {
    throw new Error("Generated app routes are protected; this root accepts CSS only.");
  }
  if (normalized.startsWith("src/components/generated/") && ![".ts", ".tsx", ".css"].includes(extension)) {
    throw new Error("Generated components accept only TypeScript and CSS.");
  }
  if (normalized.startsWith("src/content/") && ![".json", ".md"].includes(extension)) {
    throw new Error("Generated content accepts only JSON and Markdown.");
  }
  if (
    normalized.startsWith("public/generated/") &&
    ![".svg", ".png", ".jpg", ".jpeg", ".webp", ".avif", ".woff2", ".json"].includes(extension)
  ) {
    throw new Error("Generated public assets use an unsupported type.");
  }
  return normalized;
}

function assertRegularFileEntry(file: FileInfo) {
  if (file.isDir) return;
  if (file.mode && !file.mode.startsWith("-")) {
    throw new Error(`Non-regular sandbox entry rejected: ${file.path ?? file.name}`);
  }
}

function contentHash(content: Uint8Array) {
  return createHash("sha256").update(content).digest("hex");
}

function daytona(apiKey: string) {
  return new Daytona({
    apiKey,
    ...(process.env.DAYTONA_API_URL ? { apiUrl: process.env.DAYTONA_API_URL } : {}),
    ...(process.env.DAYTONA_TARGET ? { target: process.env.DAYTONA_TARGET } : {}),
    otelEnabled: false,
  });
}

function boundedTimeoutSeconds(deadlineAt: number | undefined, maximumSeconds: number, stage: string) {
  if (deadlineAt === undefined) return maximumSeconds;
  const remainingMs = deadlineAt - Date.now();
  if (remainingMs <= 0) {
    throw new IntegrationError("timeout", `The build deadline was reached during ${stage}.`, false, 504);
  }
  return Math.max(1, Math.min(maximumSeconds, Math.ceil(remainingMs / 1_000)));
}

async function destroySafely(client: Daytona, sandbox: Sandbox) {
  try {
    await client.delete(sandbox, 60);
  } finally {
    await client[Symbol.asyncDispose]();
  }
}

/** Creates a credential-free, network-blocked, ephemeral sandbox from a pinned snapshot. */
export async function createIsolatedSandbox(input: {
  apiKey: string;
  purpose: SandboxPurpose;
  runId: string;
  deadlineAt?: number;
}): Promise<SandboxHandle> {
  const snapshot =
    input.purpose === "builder"
      ? process.env.DAYTONA_BUILDER_SNAPSHOT
      : process.env.DAYTONA_VERIFIER_SNAPSHOT;
  if (!snapshot) {
    throw new IntegrationError("not_configured", `The pinned ${input.purpose} snapshot is not configured.`, false, 400);
  }

  const client = daytona(input.apiKey);
  try {
    const sandbox = await client.create(
      {
        snapshot,
        name: `reddone-${input.purpose}-${input.runId.slice(0, 12)}`,
        language: "typescript",
        envVars: {},
        labels: { app: "reddone", purpose: input.purpose, run: input.runId },
        public: false,
        ephemeral: true,
        autoStopInterval: 30,
        autoDeleteInterval: 0,
        networkBlockAll: true,
      },
      { timeout: boundedTimeoutSeconds(input.deadlineAt, 120, `${input.purpose} sandbox creation`) },
    );
    let verificationStarted = false;
    let generatedBaseline: string | null = null;
    let repositoryExportBaseline: ReadonlyMap<string, string> | null = null;
    let verifierOutputBaseline: ReadonlyMap<string, string> | null = null;
    let previewOutputBaseline: ReadonlyMap<string, string> | null = null;

    const downloadRaw = (filePath: string, timeout = 30) =>
      sandbox.fs.downloadFile(
        filePath,
        boundedTimeoutSeconds(input.deadlineAt, timeout, `${input.purpose} sandbox file download`),
      );

    const listGeneratedPaths = async () => {
      const roots = ["src/app/generated", "src/components/generated", "src/content", "public/generated"];
      const result: string[] = [];
      for (const root of roots) {
        const files = await sandbox.fs.listFiles(root, { depth: 20 });
        for (const file of files) {
          if (file.isDir) continue;
          assertRegularFileEntry(file);
          if (!file.path) throw new Error("Daytona returned a generated file without a path.");
          result.push(assertGeneratedSandboxPath(file.path));
        }
      }
      return [...new Set(result)].sort();
    };

    const snapshotFiles = async (paths: readonly string[], timeout: number, maximumBytes: number) => {
      let totalBytes = 0;
      const hashes = new Map<string, string>();
      for (const filePath of paths) {
        const content = await downloadRaw(filePath, timeout);
        totalBytes += content.byteLength;
        if (totalBytes > maximumBytes) throw new Error("Sandbox snapshot exceeds the export byte limit.");
        hashes.set(filePath, contentHash(content));
      }
      const digest = createHash("sha256")
        .update(
          [...hashes.entries()]
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([filePath, sha256]) => `${filePath}\0${sha256}`)
            .join("\n"),
        )
        .digest("hex");
      return { digest, hashes };
    };

    const assertGeneratedInvariant = async () => {
      const paths = await listGeneratedPaths();
      if (paths.length === 0 || paths.length > 2_000) throw new Error("Generated file count is outside policy.");
      const snapshot = await snapshotFiles(paths, 30, 25 * 1024 * 1024);
      if (generatedBaseline === null) generatedBaseline = snapshot.digest;
      else if (snapshot.digest !== generatedBaseline) {
        throw new Error("Generated source changed during trusted verification.");
      }
    };

    const assertTrustedExportBoundary = async () => {
      const result = await sandbox.process.executeCommand(
        trustedExportAssertion,
        undefined,
        {},
        boundedTimeoutSeconds(input.deadlineAt, 60, "trusted export assertion"),
      );
      if (result.exitCode !== 0) {
        throw new Error(`Trusted export boundary failed: ${result.result.slice(-1_000)}`);
      }
    };

    return {
      id: sandbox.id,
      purpose: input.purpose,
      readFile: async (filePath) => {
        const normalized = assertReadablePath(filePath);
        const content = await downloadRaw(normalized, 30);
        if (repositoryExportBaseline) {
          const expected = repositoryExportBaseline.get(normalized);
          if (!expected || contentHash(content) !== expected) {
            throw new Error("Repository file changed after the trusted export snapshot.");
          }
        }
        return content;
      },
      writeGeneratedFile: async (filePath, content) => {
        if (verificationStarted) throw new Error("Generated files are sealed after verification starts.");
        if (content.byteLength > 5 * 1024 * 1024) throw new Error("Generated file exceeds 5 MiB.");
        await sandbox.fs.uploadFile(
          content,
          assertGeneratedSandboxPath(filePath),
          boundedTimeoutSeconds(input.deadlineAt, 30, `${input.purpose} sandbox file upload`),
        );
      },
      listGeneratedFiles: listGeneratedPaths,
      listRepositoryFiles: async () => {
        if (input.purpose !== "verifier") throw new Error("Repository export is allowed only after clean verification.");
        verificationStarted = true;
        await assertTrustedExportBoundary();
        await assertGeneratedInvariant();
        const result: string[] = [];
        for (const root of ["src", "tests", "public"]) {
          const files = await sandbox.fs.listFiles(root, { depth: 30 });
          for (const file of files) {
            if (file.isDir) continue;
            assertRegularFileEntry(file);
            if (!file.path) throw new Error("Daytona returned a repository file without a path.");
            result.push(assertReadablePath(file.path));
          }
        }
        for (const file of [
          "package.json",
          "pnpm-lock.yaml",
          "tsconfig.json",
          "next.config.ts",
          "eslint.config.mjs",
          "playwright.config.ts",
          "vitest.config.ts",
          "vercel.json",
          "next-env.d.ts",
        ]) {
          const details = await sandbox.fs.getFileDetails(file);
          assertRegularFileEntry(details);
          result.push(file);
        }
        const paths = [...new Set(result)].sort();
        repositoryExportBaseline = (await snapshotFiles(paths, 120, 100 * 1024 * 1024)).hashes;
        return paths;
      },
      listVerifierOutputFiles: async () => {
        if (input.purpose !== "verifier") throw new Error("Build output exists only in the verifier sandbox.");
        verificationStarted = true;
        await assertTrustedExportBoundary();
        await assertGeneratedInvariant();
        const files = await sandbox.fs.listFiles(".vercel/output", { depth: 40 });
        const paths = files
          .filter((file) => {
            if (file.isDir) return false;
            assertRegularFileEntry(file);
            return true;
          })
          .map((file) => assertVerifierOutputPath(file.path ?? `.vercel/output/${file.name}`))
          .sort();
        verifierOutputBaseline = (await snapshotFiles(paths, 120, 192 * 1024 * 1024)).hashes;
        return paths;
      },
      readVerifierOutputFile: async (filePath) => {
        if (input.purpose !== "verifier") throw new Error("Build output exists only in the verifier sandbox.");
        const normalized = assertVerifierOutputPath(filePath);
        const expected = verifierOutputBaseline?.get(normalized);
        if (!expected) throw new Error("Verifier output must be snapshotted before it is read.");
        const content = await downloadRaw(normalized, 120);
        if (contentHash(content) !== expected) throw new Error("Verifier output changed during trusted export.");
        return content;
      },
      listPreviewOutputFiles: async () => {
        if (input.purpose !== "verifier") throw new Error("Static preview output exists only in the verifier sandbox.");
        verificationStarted = true;
        await assertTrustedExportBoundary();
        await assertGeneratedInvariant();
        const files = await sandbox.fs.listFiles(".vercel/preview-output", { depth: 40 });
        const paths = files
          .filter((file) => {
            if (file.isDir) return false;
            assertRegularFileEntry(file);
            return true;
          })
          .map((file) => assertPreviewOutputPath(file.path ?? `.vercel/preview-output/${file.name}`))
          .sort();
        previewOutputBaseline = (await snapshotFiles(paths, 120, 100 * 1024 * 1024)).hashes;
        return paths;
      },
      readPreviewOutputFile: async (filePath) => {
        if (input.purpose !== "verifier") throw new Error("Static preview output exists only in the verifier sandbox.");
        const normalized = assertPreviewOutputPath(filePath);
        const expected = previewOutputBaseline?.get(normalized);
        if (!expected) throw new Error("Static preview output must be snapshotted before it is read.");
        const content = await downloadRaw(normalized, 120);
        if (contentHash(content) !== expected) throw new Error("Static preview output changed during trusted export.");
        return content;
      },
      searchText: async (query) => {
        if (input.purpose !== "builder") throw new Error("Text search is exposed only to the constrained builder.");
        if (!query.trim() || query.length > 200) throw new Error("Search query is invalid.");
        const matches = await sandbox.fs.findFiles("src", query);
        return matches.slice(0, 100).map((match) => ({
          file: match.file,
          line: match.line,
          content: match.content?.slice(0, 500),
        }));
      },
      runVerifierGate: async (gate) => {
        if (input.purpose !== "verifier") throw new Error("Verifier gates cannot run in the builder sandbox.");
        verificationStarted = true;
        await assertGeneratedInvariant();
        try {
          const result = await sandbox.process.executeCommand(
            trustedVerifierCommands[gate],
            undefined,
            {},
            boundedTimeoutSeconds(input.deadlineAt, 300, `verifier gate ${gate}`),
          );
          return { gate, exitCode: result.exitCode, output: result.result.slice(-8_000) };
        } finally {
          await assertGeneratedInvariant();
        }
      },
      destroy: () => destroySafely(client, sandbox),
    };
  } catch (error) {
    await client[Symbol.asyncDispose]();
    if (error instanceof IntegrationError) throw error;
    throw new IntegrationError("provider_error", `Daytona could not create the ${input.purpose} sandbox.`, true);
  }
}

export async function testDaytonaConnection(apiKey: string) {
  const client = daytona(apiKey);
  try {
    const iterator = client.list({ limit: 1 });
    await iterator.next();
    return { ok: true as const };
  } catch {
    throw new IntegrationError("provider_error", "Daytona rejected this credential.", false, 400);
  } finally {
    await client[Symbol.asyncDispose]();
  }
}

export async function cleanupRunSandboxes(apiKey: string, runId: string) {
  const client = daytona(apiKey);
  const deleted: string[] = [];
  try {
    for await (const sandbox of client.list({ labels: { app: "reddone", run: runId } })) {
      await client.delete(sandbox, 60);
      deleted.push(sandbox.id);
    }
    // Deletion acknowledgement is not cleanup proof. Re-list by the immutable run
    // label so eventually-consistent or partially failed deletions remain recoverable.
    const remaining: string[] = [];
    for await (const sandbox of client.list({ labels: { app: "reddone", run: runId } })) {
      remaining.push(sandbox.id);
    }
    return { deleted, remaining, confirmed: remaining.length === 0 };
  } finally {
    await client[Symbol.asyncDispose]();
  }
}
