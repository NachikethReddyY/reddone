#!/usr/bin/env node

import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";

const mode = process.argv[2];
const workspace =
  process.env.NODE_ENV === "test" && process.env.REDDONE_VERIFY_WORKSPACE
    ? path.resolve(process.env.REDDONE_VERIFY_WORKSPACE)
    : "/workspace";
const releaseRoot = path.join(workspace, ".vercel/output");
const previewRoot = path.join(workspace, ".vercel/preview-output");
const nextVersion = "16.2.10";

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function exactKeys(value, expected, label) {
  if (!plainObject(value) || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())) {
    throw new Error(`${label} has unexpected fields.`);
  }
}

async function json(file) {
  const raw = await readFile(file, "utf8");
  if (Buffer.byteLength(raw) > 1024 * 1024) throw new Error(`${file} exceeds the JSON policy.`);
  return JSON.parse(raw);
}

function safeRelative(value, label) {
  if (typeof value !== "string" || !value || value.length > 2_048 || path.posix.isAbsolute(value) || value.includes("\\") || value.includes("\0") || value.split("/").includes("..")) {
    throw new Error(`${label} is not a safe relative path.`);
  }
}

function validateRoutePredicate(value, label) {
  if (!Array.isArray(value) || value.length > 20) throw new Error(`${label} is invalid.`);
  for (const predicate of value) {
    if (!plainObject(predicate)) throw new Error(`${label} predicate is invalid.`);
    const keys = Object.keys(predicate).sort();
    if (!["key,type", "key,type,value"].includes(keys.join(","))) throw new Error(`${label} predicate is invalid.`);
    if (![predicate.type, predicate.key, predicate.value].filter((item) => item !== undefined).every((item) => typeof item === "string" && item.length <= 2_048)) {
      throw new Error(`${label} predicate value is invalid.`);
    }
  }
}

function validateReleaseConfig(config) {
  exactKeys(config, ["version", "routes", "overrides", "framework", "crons"], "Release Build Output config");
  if (config.version !== 3) throw new Error("Release Build Output must use schema version 3.");
  exactKeys(config.framework, ["slug", "version"], "Release framework");
  if (config.framework.slug !== "nextjs" || config.framework.version !== nextVersion) throw new Error("Release framework pin mismatch.");
  if (!Array.isArray(config.crons) || config.crons.length !== 0) throw new Error("Generated releases cannot define cron jobs.");
  if (!Array.isArray(config.routes) || config.routes.length < 1 || config.routes.length > 200) throw new Error("Release route count is invalid.");
  const allowedRouteKeys = new Set(["check", "continue", "dest", "handle", "has", "headers", "important", "missing", "override", "src", "status"]);
  const handles = new Set(["filesystem", "resource", "miss", "rewrite", "hit", "error"]);
  for (const route of config.routes) {
    if (!plainObject(route) || Object.keys(route).some((key) => !allowedRouteKeys.has(key))) throw new Error("Release route has unexpected fields.");
    if (route.handle !== undefined && !handles.has(route.handle)) throw new Error("Release route handle is invalid.");
    if (route.src !== undefined && (typeof route.src !== "string" || route.src.length > 2_048)) throw new Error("Release route source is invalid.");
    if (route.dest !== undefined && (typeof route.dest !== "string" || !route.dest.startsWith("/") || route.dest.startsWith("//") || route.dest.length > 2_048)) throw new Error("Release route destination is invalid.");
    if (route.status !== undefined && (!Number.isInteger(route.status) || route.status < 100 || route.status > 599)) throw new Error("Release route status is invalid.");
    for (const flag of ["check", "continue", "important", "override"]) {
      if (route[flag] !== undefined && typeof route[flag] !== "boolean") throw new Error(`Release route ${flag} flag is invalid.`);
    }
    if (route.has !== undefined) validateRoutePredicate(route.has, "Release route has");
    if (route.missing !== undefined) validateRoutePredicate(route.missing, "Release route missing");
    if (route.headers !== undefined) {
      if (!plainObject(route.headers) || Object.keys(route.headers).length > 50) throw new Error("Release route headers are invalid.");
      for (const [key, value] of Object.entries(route.headers)) {
        if (!key || key.length > 200 || typeof value !== "string" || value.length > 4_096 || key.toLowerCase() === "set-cookie") throw new Error("Release route header is invalid.");
      }
    }
  }
  if (!plainObject(config.overrides) || Object.keys(config.overrides).length > 100) throw new Error("Release overrides are invalid.");
  for (const [file, override] of Object.entries(config.overrides)) {
    safeRelative(file, "Release override path");
    if (!plainObject(override)) throw new Error("Release override is invalid.");
    const keys = Object.keys(override).sort();
    if (!["contentType", "contentType,path"].includes(keys.join(","))) throw new Error("Release override is invalid.");
    if (override.path !== undefined) safeRelative(override.path, "Release override target");
    if (typeof override.contentType !== "string" || override.contentType.length > 200) throw new Error("Release override content type is invalid.");
  }
}

async function collectFunctionDirectories(directory, result = []) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(directory, entry.name);
    if (entry.name.endsWith(".func")) result.push(candidate);
    else await collectFunctionDirectories(candidate, result);
  }
  return result;
}

async function validateFunctions() {
  const functionRoot = path.join(releaseRoot, "functions");
  const functions = await collectFunctionDirectories(functionRoot);
  if (functions.length < 1 || functions.length > 200) throw new Error("Release function count is invalid.");
  for (const directory of functions) {
    const config = await json(path.join(directory, ".vc-config.json"));
    if (!plainObject(config) || config.runtime !== "nodejs24.x" || "filePathMap" in config) throw new Error("Release function is not a standalone Node 24 function.");
    safeRelative(config.handler, "Release function handler");
    if (!(await lstat(path.join(directory, config.handler))).isFile()) throw new Error("Release function handler is missing.");
    if (!plainObject(config.environment) || Object.keys(config.environment).length !== 0) throw new Error("Build-time function environment must be empty.");
    if (config.framework !== undefined) {
      exactKeys(config.framework, ["slug", "version"], "Function framework");
      if (config.framework.slug !== "nextjs" || config.framework.version !== nextVersion) throw new Error("Function framework pin mismatch.");
    }
  }
  if (!(await lstat(path.join(releaseRoot, "functions/api/health.func/.vc-config.json"))).isFile()) throw new Error("Trusted release health function is missing.");
}

async function validateRegularTree(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const candidate = path.join(directory, entry.name);
    const details = await lstat(candidate);
    if (details.isDirectory()) await validateRegularTree(candidate);
    else if (!details.isFile() || details.isSymbolicLink() || details.nlink !== 1) throw new Error(`Build Output contains a link or special entry: ${candidate}`);
  }
}

async function validateProject() {
  const project = await json(path.join(workspace, ".vercel/project.json"));
  const expected = {
    orgId: "org_reddone_offline_build",
    projectId: "prj_reddone_offline_build",
    projectName: "reddone-generated-app",
    settings: {
      createdAt: 0,
      framework: "nextjs",
      devCommand: null,
      installCommand: "true",
      buildCommand: "./node_modules/.bin/next build --webpack",
      outputDirectory: null,
      rootDirectory: null,
      directoryListing: false,
      nodeVersion: "24.x",
    },
  };
  if (JSON.stringify(project) !== JSON.stringify(expected)) throw new Error("Offline Vercel project settings do not match the immutable policy.");
}

async function validatePreview() {
  const config = await json(path.join(previewRoot, "config.json"));
  exactKeys(config, ["version", "framework"], "Preview Build Output config");
  exactKeys(config.framework, ["version"], "Preview framework");
  if (config.version !== 3 || config.framework.version !== nextVersion) throw new Error("Preview Build Output pin mismatch.");
  if (!(await lstat(path.join(previewRoot, "static/index.html"))).isFile() || !(await lstat(path.join(previewRoot, "static/health.json"))).isFile()) {
    throw new Error("Preview static entrypoint or health document is missing.");
  }
  try {
    await lstat(path.join(previewRoot, "functions"));
    throw new Error("Preview output must not contain functions.");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await validateRegularTree(previewRoot);
}

if (mode === "project") await validateProject();
else if (mode === "release-config") validateReleaseConfig(await json(path.join(releaseRoot, "config.json")));
else if (mode === "release") {
  validateReleaseConfig(await json(path.join(releaseRoot, "config.json")));
  await validateRegularTree(releaseRoot);
  await validateFunctions();
  if (!(await lstat(path.join(releaseRoot, "functions/index.prerender-fallback.html"))).isFile()) {
    throw new Error("Release prerendered entrypoint is missing.");
  }
} else if (mode === "preview") await validatePreview();
else throw new Error("Unknown Build Output validation mode.");

process.stdout.write(`${mode} Build Output policy passed\n`);
