import "server-only";

import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open, readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import { IntegrationError } from "./errors";
import {
  createVercelDeploymentMetadata,
  REDDONE_VERCEL_ARTIFACT_META_KEY,
  REDDONE_VERCEL_OWNERSHIP_ENV_KEY,
  REDDONE_VERCEL_RUN_META_KEY,
  type VercelDeploymentMetadata,
} from "./vercel";

interface PrebuiltTarget {
  token: string;
  teamId: string;
  projectId: string;
  cwd: string;
}

const MAX_PREBUILT_FILES = 20_000;
const MAX_PREBUILT_FILE_BYTES = 10 * 1024 * 1024;
const MAX_PREBUILT_TOTAL_BYTES = 192 * 1024 * 1024;
const FILE_UPLOAD_CONCURRENCY = 8;
const FILE_UPLOAD_ATTEMPTS = 4;

const linkedProjectSchema = z
  .object({
    orgId: z.string().min(1).max(256),
    projectId: z.string().min(1).max(256),
    projectName: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,99}$/),
  })
  .strict();

const buildOutputConfigSchema = z.object({ version: z.literal(3) }).passthrough();

export interface VercelPrebuiltFileReference {
  file: string;
  sha: string;
  size: number;
}

interface MaterializedPrebuiltFile extends VercelPrebuiltFileReference {
  content: Buffer;
}

const missingFilesSchema = z
  .object({
    error: z
      .object({
        code: z.literal("missing_files"),
        missing: z.array(z.string().regex(/^[a-f0-9]{40}$/)).max(MAX_PREBUILT_FILES),
      })
      .passthrough(),
  })
  .passthrough();

const deploymentResponseSchema = z
  .object({
    id: z.string().min(1).max(256).optional(),
    uid: z.string().min(1).max(256).optional(),
    url: z.string().min(1).max(2_048),
  })
  .passthrough()
  .refine((value) => Boolean(value.id ?? value.uid), "Vercel deployment is missing its id.");

function providerStatus(response: Response) {
  return response.status === 429 ? 429 : response.status >= 500 ? 502 : response.status;
}

function isRetryableStatus(status: number) {
  return status === 408 || status === 429 || status >= 500;
}

function normalizeVercelDeploymentUrl(value: string) {
  const candidate = new URL(value.startsWith("https://") ? value : `https://${value}`);
  if (
    candidate.protocol !== "https:" ||
    candidate.username ||
    candidate.password ||
    candidate.port ||
    candidate.pathname !== "/" ||
    candidate.search ||
    candidate.hash ||
    !candidate.hostname.endsWith(".vercel.app")
  ) {
    throw new IntegrationError("invalid_response", "Vercel returned an invalid deployment URL.");
  }
  return candidate.origin;
}

function safeRelativeFile(root: string, candidate: string) {
  const relative = path.relative(root, candidate).split(path.sep).join("/");
  if (!relative || relative.startsWith("../") || relative.includes("\\") || relative.split("/").includes("..")) {
    throw new IntegrationError("provider_error", "The prebuilt output contains an unsafe path.", false, 400);
  }
  return relative;
}

async function readExactRegularFile(filePath: string) {
  let handle;
  try {
    handle = await open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_PREBUILT_FILE_BYTES) {
      throw new IntegrationError("provider_error", "The prebuilt output contains an unsupported or oversized file.", false, 400);
    }
    const content = await handle.readFile();
    if (content.byteLength !== stat.size) {
      throw new IntegrationError("provider_error", "The prebuilt output changed while it was being read.", false, 409);
    }
    return content;
  } catch (error) {
    if (error instanceof IntegrationError) throw error;
    throw new IntegrationError("provider_error", "The prebuilt output could not be read safely.", false, 400);
  } finally {
    await handle?.close();
  }
}

async function collectRegularFiles(root: string, directory: string, output: MaterializedPrebuiltFile[]) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    throw new IntegrationError("provider_error", "The verified Vercel output directory is unavailable.", false, 400);
  }
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (output.length >= MAX_PREBUILT_FILES) {
      throw new IntegrationError("provider_error", "The prebuilt output exceeds the file-count limit.", false, 400);
    }
    const candidate = path.join(directory, entry.name);
    if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) {
      throw new IntegrationError("provider_error", "The prebuilt output contains a non-regular filesystem entry.", false, 400);
    }
    if (entry.isDirectory()) {
      await collectRegularFiles(root, candidate, output);
      continue;
    }
    const content = await readExactRegularFile(candidate);
    const file = safeRelativeFile(path.dirname(path.dirname(root)), candidate);
    output.push({ file, sha: createHash("sha1").update(content).digest("hex"), size: content.byteLength, content });
  }
}

async function materializePrebuiltRequest(target: PrebuiltTarget, metadata: VercelDeploymentMetadata) {
  const cwd = path.resolve(target.cwd);
  const vercelRoot = path.join(cwd, ".vercel");
  const outputRoot = path.join(cwd, ".vercel", "output");
  const projectConfigPath = path.join(vercelRoot, "project.json");
  const outputConfigPath = path.join(outputRoot, "config.json");
  const [vercelStat, outputStat, projectConfigStat, outputConfigStat, projectConfigBytes, outputConfigBytes] = await Promise.all([
    lstat(vercelRoot).catch(() => null),
    lstat(outputRoot).catch(() => null),
    lstat(projectConfigPath).catch(() => null),
    lstat(outputConfigPath).catch(() => null),
    readFile(projectConfigPath, "utf8").catch(() => null),
    readFile(outputConfigPath, "utf8").catch(() => null),
  ]);
  if (
    !vercelStat?.isDirectory() ||
    vercelStat.isSymbolicLink() ||
    !outputStat?.isDirectory() ||
    outputStat.isSymbolicLink() ||
    !projectConfigStat?.isFile() ||
    projectConfigStat.isSymbolicLink() ||
    !outputConfigStat?.isFile() ||
    outputConfigStat.isSymbolicLink() ||
    !projectConfigBytes ||
    !outputConfigBytes
  ) {
    throw new IntegrationError("provider_error", "A materialized .vercel/output and linked project are required.", false, 400);
  }

  let projectConfig: z.infer<typeof linkedProjectSchema>;
  try {
    projectConfig = linkedProjectSchema.parse(JSON.parse(projectConfigBytes));
    buildOutputConfigSchema.parse(JSON.parse(outputConfigBytes));
  } catch {
    throw new IntegrationError("provider_error", "The materialized Vercel output metadata is invalid.", false, 400);
  }
  if (projectConfig.orgId !== target.teamId || projectConfig.projectId !== target.projectId) {
    throw new IntegrationError("provider_error", "The materialized Vercel output is linked to a different project.", false, 409);
  }

  const files: MaterializedPrebuiltFile[] = [];
  await collectRegularFiles(outputRoot, outputRoot, files);
  if (files.length === 0 || !files.some((file) => file.file === ".vercel/output/config.json")) {
    throw new IntegrationError("provider_error", "The materialized Vercel output is empty or incomplete.", false, 400);
  }
  const totalBytes = files.reduce((total, file) => total + file.size, 0);
  if (totalBytes > MAX_PREBUILT_TOTAL_BYTES) {
    throw new IntegrationError("provider_error", "The prebuilt output exceeds the total size limit.", false, 400);
  }
  return {
    files,
    body: buildPrebuiltDeploymentRequest({
      projectId: target.projectId,
      projectName: projectConfig.projectName,
      metadata,
      files,
    }),
  };
}

export function buildPrebuiltDeploymentRequest(input: {
  projectId: string;
  projectName: string;
  metadata: VercelDeploymentMetadata;
  files: readonly VercelPrebuiltFileReference[];
}) {
  const metadata = createVercelDeploymentMetadata(input.metadata);
  const project = z.string().min(1).max(256).parse(input.projectId);
  const name = linkedProjectSchema.shape.projectName.parse(input.projectName);
  const files = z
    .array(
      z
        .object({
          file: z.string().startsWith(".vercel/output/").max(1_024),
          sha: z.string().regex(/^[a-f0-9]{40}$/),
          size: z.number().int().nonnegative().max(MAX_PREBUILT_FILE_BYTES),
        })
        .strict(),
    )
    .min(1)
    .max(MAX_PREBUILT_FILES)
    .parse(input.files.map(({ file, sha, size }) => ({ file, sha, size })));
  return {
    version: 2 as const,
    source: "cli" as const,
    name,
    project,
    meta: {
      [REDDONE_VERCEL_RUN_META_KEY]: metadata.runId,
      [REDDONE_VERCEL_ARTIFACT_META_KEY]: metadata.artifactHash,
    },
    files,
    env: { REDDONE_ARTIFACT_HASH: metadata.artifactHash },
  };
}

export const REDDONE_RUNTIME_ENV_COMMENT = "reddone:managed-project-secret:v1";

const runtimeSecretNameSchema = z.string().regex(/^[A-Z][A-Z0-9_]{1,99}$/);
const runtimeTargetSchema = z.enum(["production", "preview"]);
const listedRuntimeVariableSchema = z
  .object({
    id: z.string().min(1),
    key: z.string().min(1).max(256),
    type: z.string().min(1),
    target: z.union([z.string(), z.array(z.string())]).optional(),
    comment: z.string().nullable().optional(),
    gitBranch: z.string().nullable().optional(),
    customEnvironmentIds: z.array(z.string()).optional(),
  })
  .passthrough();
const runtimeVariableListSchema = z
  .object({
    envs: z.array(listedRuntimeVariableSchema).max(2_000),
    hiddenProductionEnvCount: z.number().int().nonnegative().optional().default(0),
  })
  .passthrough();

export interface VercelRuntimeEnvironmentRecord {
  id: string;
  key: string;
  type: string;
  targets: string[];
  comment: string | null;
  gitBranch: string | null;
  customEnvironmentIds: string[];
}

function isManagedRuntimeVariable(variable: VercelRuntimeEnvironmentRecord) {
  return variable.comment === REDDONE_RUNTIME_ENV_COMMENT;
}

function isCanonicalRuntimeVariable(variable: VercelRuntimeEnvironmentRecord, target: "production" | "preview") {
  return (
    variable.type === "sensitive" &&
    variable.targets.length === 1 &&
    variable.targets[0] === target &&
    variable.gitBranch === null &&
    variable.customEnvironmentIds.length === 0
  );
}

export function planVercelRuntimeEnvironment(input: {
  existing: readonly VercelRuntimeEnvironmentRecord[];
  desiredKeys: readonly string[];
  target: "production" | "preview";
}) {
  const target = runtimeTargetSchema.parse(input.target);
  const desiredKeys = input.desiredKeys.map((key) => runtimeSecretNameSchema.parse(key));
  const desired = new Set(desiredKeys);
  if (desired.size !== desiredKeys.length) throw new Error("Approved runtime secret names must be unique.");

  const ownerCollisions = input.existing
    .filter((variable) => desired.has(variable.key) && !isManagedRuntimeVariable(variable))
    .map((variable) => variable.key)
    .filter((key, index, keys) => keys.indexOf(key) === index)
    .sort();
  if (ownerCollisions.length > 0) {
    throw new IntegrationError(
      "provider_error",
      `Vercel runtime variable reconciliation refused owner-managed key collisions: ${ownerCollisions.join(", ")}.`,
      false,
      409,
    );
  }

  const keptKeys = new Set<string>();
  const deleteEntries: VercelRuntimeEnvironmentRecord[] = [];
  for (const variable of input.existing) {
    if (!isManagedRuntimeVariable(variable)) continue;
    const canonical = desired.has(variable.key) && isCanonicalRuntimeVariable(variable, target);
    if (!canonical || keptKeys.has(variable.key)) {
      deleteEntries.push(variable);
    } else {
      keptKeys.add(variable.key);
    }
  }

  return {
    deleteEntries,
    keptKeys: [...keptKeys].sort(),
    desiredKeys: [...desired].sort(),
  };
}

function parseRuntimeVariableList(body: unknown) {
  const parsed = runtimeVariableListSchema.safeParse(body);
  if (!parsed.success) {
    throw new IntegrationError("invalid_response", "Vercel returned an invalid runtime variable inventory.", true);
  }
  if (parsed.data.hiddenProductionEnvCount > 0) {
    throw new IntegrationError(
      "insufficient_scope",
      "Vercel hid project runtime variables from the integration; exact reconciliation was refused.",
      false,
      403,
    );
  }
  return parsed.data.envs.map((variable) => ({
    id: variable.id,
    key: variable.key,
    type: variable.type,
    targets: variable.target === undefined ? [] : Array.isArray(variable.target) ? variable.target : [variable.target],
    comment: variable.comment ?? null,
    gitBranch: variable.gitBranch ?? null,
    customEnvironmentIds: variable.customEnvironmentIds ?? [],
  }));
}

async function listProjectRuntimeVariables(input: { token: string; teamId: string; projectId: string }) {
  let response: Response;
  try {
    response = await fetch(
      `https://api.vercel.com/v10/projects/${encodeURIComponent(input.projectId)}/env?teamId=${encodeURIComponent(input.teamId)}`,
      { headers: { authorization: `Bearer ${input.token}` }, cache: "no-store" },
    );
  } catch {
    throw new IntegrationError("provider_error", "Vercel runtime variable inventory failed.", true);
  }
  if (!response.ok) {
    throw new IntegrationError(
      "provider_error",
      "Vercel runtime variable inventory failed.",
      response.status === 429 || response.status >= 500,
      response.status === 429 ? 429 : response.status >= 500 ? 502 : 403,
    );
  }
  return parseRuntimeVariableList(await response.json());
}

async function deleteProjectRuntimeVariable(input: { token: string; teamId: string; projectId: string; envId: string }) {
  let response: Response;
  try {
    response = await fetch(
      `https://api.vercel.com/v10/projects/${encodeURIComponent(input.projectId)}/env/${encodeURIComponent(input.envId)}?teamId=${encodeURIComponent(input.teamId)}`,
      { method: "DELETE", headers: { authorization: `Bearer ${input.token}` }, cache: "no-store" },
    );
  } catch {
    throw new IntegrationError("provider_error", "Vercel could not remove a stale managed runtime variable.", true);
  }
  if (!response.ok) {
    throw new IntegrationError(
      "provider_error",
      "Vercel could not remove a stale managed runtime variable.",
      response.status === 429 || response.status >= 500,
      response.status === 429 ? 429 : response.status >= 500 ? 502 : 403,
    );
  }
}

async function upsertSensitiveRuntimeVariable(input: {
  token: string;
  teamId: string;
  projectId: string;
  key: string;
  value: string;
  target: "production" | "preview";
}) {
  const key = runtimeSecretNameSchema.parse(input.key);
  const target = runtimeTargetSchema.parse(input.target);
  let response: Response;
  try {
    response = await fetch(`https://api.vercel.com/v10/projects/${encodeURIComponent(input.projectId)}/env?teamId=${encodeURIComponent(input.teamId)}&upsert=true`, {
      method: "POST",
      headers: { authorization: `Bearer ${input.token}`, "content-type": "application/json" },
      body: JSON.stringify({
        key,
        value: input.value,
        type: "sensitive",
        target: [target],
        comment: REDDONE_RUNTIME_ENV_COMMENT,
      }),
      cache: "no-store",
    });
  } catch {
    throw new IntegrationError("provider_error", "Vercel rejected an approved runtime secret version.", true);
  }
  if (!response.ok) {
    throw new IntegrationError(
      "provider_error",
      "Vercel rejected an approved runtime secret version.",
      response.status === 429 || response.status >= 500,
      response.status === 429 ? 429 : response.status >= 500 ? 502 : 403,
    );
  }
}

export async function reconcileSensitiveRuntimeVariables(input: {
  token: string;
  teamId: string;
  projectId: string;
  target: "production" | "preview";
  variables: readonly { key: string; value: string }[];
}) {
  const target = runtimeTargetSchema.parse(input.target);
  const variables = z
    .array(z.object({ key: runtimeSecretNameSchema, value: z.string().min(1).max(64 * 1024) }).strict())
    .max(100)
    .parse(input.variables);
  const desiredKeys = variables.map((variable) => variable.key);
  if (new Set(desiredKeys).size !== desiredKeys.length) throw new Error("Approved runtime secret names must be unique.");
  const reservedKeys = new Set([REDDONE_VERCEL_OWNERSHIP_ENV_KEY, "REDDONE_ARTIFACT_HASH"]);
  if (desiredKeys.some((key) => reservedKeys.has(key))) {
    throw new Error("Approved runtime secret names cannot use ReDDone deployment identity keys.");
  }

  const providerTarget = { token: input.token, teamId: input.teamId, projectId: input.projectId };
  const inventory = await listProjectRuntimeVariables(providerTarget);
  const plan = planVercelRuntimeEnvironment({ existing: inventory, desiredKeys, target });
  for (const variable of plan.deleteEntries) {
    await deleteProjectRuntimeVariable({ ...providerTarget, envId: variable.id });
  }
  for (const variable of variables) {
    await upsertSensitiveRuntimeVariable({ ...providerTarget, ...variable, target });
  }

  if (plan.deleteEntries.length > 0 || variables.length > 0) {
    const verified = await listProjectRuntimeVariables(providerTarget);
    const verificationPlan = planVercelRuntimeEnvironment({ existing: verified, desiredKeys, target });
    if (
      verificationPlan.deleteEntries.length > 0 ||
      verificationPlan.keptKeys.length !== verificationPlan.desiredKeys.length
    ) {
      throw new IntegrationError("invalid_response", "Vercel runtime variables did not converge to the exact approved set.", true);
    }
  }

  return {
    removedKeys: [...new Set(plan.deleteEntries.map((variable) => variable.key))].sort(),
    upsertedKeys: [...desiredKeys].sort(),
  };
}

async function readProviderJson(response: Response) {
  return response.json().catch(() => null) as Promise<unknown>;
}

async function createPrebuiltDeployment(target: PrebuiltTarget, body: ReturnType<typeof buildPrebuiltDeploymentRequest>) {
  const url = new URL("https://api.vercel.com/v13/deployments");
  url.searchParams.set("teamId", target.teamId);
  url.searchParams.set("prebuilt", "1");
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${target.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      cache: "no-store",
      signal: AbortSignal.timeout(60_000),
    });
  } catch {
    throw new IntegrationError(
      "provider_error",
      "Vercel deployment creation had an ambiguous network failure; reconciliation is required before retrying.",
      true,
    );
  }

  const responseBody = await readProviderJson(response);
  const missing = missingFilesSchema.safeParse(responseBody);
  if (missing.success) {
    if (response.ok) throw new IntegrationError("invalid_response", "Vercel returned a contradictory missing-file response.");
    return { kind: "missing" as const, hashes: missing.data.error.missing };
  }
  if (!response.ok) {
    throw new IntegrationError(
      "provider_error",
      "Vercel rejected the verified prebuilt deployment.",
      isRetryableStatus(response.status),
      providerStatus(response),
    );
  }
  const deployment = deploymentResponseSchema.safeParse(responseBody);
  if (!deployment.success) throw new IntegrationError("invalid_response", "Vercel returned an invalid deployment response.");
  return {
    kind: "created" as const,
    id: deployment.data.id ?? deployment.data.uid!,
    url: normalizeVercelDeploymentUrl(deployment.data.url),
  };
}

function retryDelayMs(response: Response | null, attempt: number) {
  if (response?.status === 429) {
    const retryAfter = Number(response.headers.get("retry-after"));
    if (Number.isFinite(retryAfter) && retryAfter >= 0) return Math.min(2_000, retryAfter * 1_000);
  }
  return Math.min(1_000, 25 * 2 ** attempt);
}

async function uploadPrebuiltFile(target: PrebuiltTarget, file: MaterializedPrebuiltFile) {
  const url = new URL("https://api.vercel.com/v2/files");
  url.searchParams.set("teamId", target.teamId);
  let lastResponse: Response | null = null;
  for (let attempt = 0; attempt < FILE_UPLOAD_ATTEMPTS; attempt += 1) {
    try {
      lastResponse = await fetch(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${target.token}`,
          "content-type": "application/octet-stream",
          "content-length": String(file.size),
          "x-vercel-digest": file.sha,
          "x-now-digest": file.sha,
          "x-now-size": String(file.size),
        },
        body: file.content as unknown as BodyInit,
        cache: "no-store",
        signal: AbortSignal.timeout(60_000),
      });
      if (lastResponse.ok) return;
      if (!isRetryableStatus(lastResponse.status)) {
        throw new IntegrationError(
          "provider_error",
          "Vercel rejected a requested prebuilt file.",
          false,
          providerStatus(lastResponse),
        );
      }
    } catch (error) {
      if (error instanceof IntegrationError) throw error;
      lastResponse = null;
    }
    if (attempt + 1 < FILE_UPLOAD_ATTEMPTS) {
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs(lastResponse, attempt)));
    }
  }
  throw new IntegrationError(
    "provider_error",
    "Vercel could not receive a requested prebuilt file after bounded retries.",
    true,
    lastResponse ? providerStatus(lastResponse) : 502,
  );
}

async function mapConcurrent<T>(items: readonly T[], limit: number, mapper: (item: T) => Promise<void>) {
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      await mapper(items[index]!);
    }
  });
  await Promise.all(workers);
}

/**
 * Uploads the verifier-created Build Output API tree directly. The creation request contains
 * only file hashes and the non-secret artifact identity, so Vercel never executes a build step.
 */
export async function deployPrebuiltPreview(target: PrebuiltTarget, metadata: VercelDeploymentMetadata) {
  const materialized = await materializePrebuiltRequest(target, metadata);
  const first = await createPrebuiltDeployment(target, materialized.body);
  if (first.kind === "created") return first.url;

  const fileByHash = new Map(materialized.files.map((file) => [file.sha, file]));
  const requested = [...new Set(first.hashes)];
  if (requested.length !== first.hashes.length || requested.some((hash) => !fileByHash.has(hash))) {
    throw new IntegrationError("invalid_response", "Vercel requested an unknown or duplicate prebuilt file hash.");
  }
  await mapConcurrent(requested, FILE_UPLOAD_CONCURRENCY, async (hash) => uploadPrebuiltFile(target, fileByHash.get(hash)!));

  const second = await createPrebuiltDeployment(target, materialized.body);
  if (second.kind === "missing") {
    throw new IntegrationError("provider_error", "Vercel still reported missing files after the bounded upload pass.", true);
  }
  return second.url;
}

const deploymentHealthSchema = z
  .object({
    status: z.literal("ok"),
    artifactHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

export async function assertDeploymentHealthy(url: string, expectedArtifactHash: string) {
  const expectedHash = z.string().regex(/^[a-f0-9]{64}$/).parse(expectedArtifactHash);
  const candidate = new URL(url);
  if (
    candidate.protocol !== "https:" ||
    candidate.username ||
    candidate.password ||
    candidate.port ||
    !candidate.hostname.endsWith(".vercel.app")
  ) {
    throw new IntegrationError("provider_error", "The candidate deployment URL is invalid.", false, 424);
  }
  const response = await fetch(new URL("/api/health", candidate), {
    redirect: "manual",
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });
  if (
    response.redirected ||
    response.status !== 200 ||
    !response.headers.get("content-type")?.toLowerCase().includes("application/json")
  ) {
    throw new IntegrationError("provider_error", "The candidate deployment failed its health check.", false, 424);
  }
  const parsed = deploymentHealthSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success || parsed.data.artifactHash !== expectedHash) {
    throw new IntegrationError("provider_error", "The candidate deployment health response did not match the approved artifact.", false, 424);
  }
  return { ok: true as const, status: response.status, artifactHash: parsed.data.artifactHash };
}

export async function promoteDeployment(target: PrebuiltTarget, previewUrl: string) {
  const normalizedPreviewUrl = normalizeVercelDeploymentUrl(previewUrl);
  const deploymentUrl = new URL(
    `https://api.vercel.com/v13/deployments/${encodeURIComponent(new URL(normalizedPreviewUrl).hostname)}`,
  );
  deploymentUrl.searchParams.set("teamId", target.teamId);
  let lookup: Response;
  try {
    lookup = await fetch(deploymentUrl, {
      headers: { authorization: `Bearer ${target.token}` },
      cache: "no-store",
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new IntegrationError("provider_error", "Vercel could not resolve the approved deployment for promotion.", true);
  }
  if (!lookup.ok) {
    throw new IntegrationError(
      "provider_error",
      "Vercel could not resolve the approved deployment for promotion.",
      isRetryableStatus(lookup.status),
      providerStatus(lookup),
    );
  }
  const deployment = deploymentResponseSchema
    .extend({ projectId: z.string().min(1).max(256) })
    .safeParse(await readProviderJson(lookup));
  if (
    !deployment.success ||
    deployment.data.projectId !== target.projectId ||
    normalizeVercelDeploymentUrl(deployment.data.url) !== normalizedPreviewUrl
  ) {
    throw new IntegrationError("invalid_response", "Vercel returned a different deployment than the approved promotion target.");
  }
  const deploymentId = deployment.data.id ?? deployment.data.uid!;
  const promoteUrl = new URL(
    `https://api.vercel.com/v10/projects/${encodeURIComponent(target.projectId)}/promote/${encodeURIComponent(deploymentId)}`,
  );
  promoteUrl.searchParams.set("teamId", target.teamId);
  let promoted: Response;
  try {
    promoted = await fetch(promoteUrl, {
      method: "POST",
      headers: { authorization: `Bearer ${target.token}`, "content-type": "application/json" },
      body: "{}",
      cache: "no-store",
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new IntegrationError("provider_error", "Vercel promotion had an ambiguous network failure.", true);
  }
  if (!promoted.ok) {
    throw new IntegrationError(
      "provider_error",
      "Vercel rejected the approved deployment promotion.",
      isRetryableStatus(promoted.status),
      providerStatus(promoted),
    );
  }
  return { promoted: true as const, previewUrl: normalizedPreviewUrl };
}
