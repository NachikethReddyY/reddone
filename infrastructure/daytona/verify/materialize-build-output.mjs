#!/usr/bin/env node

import { cp, lstat, mkdir, readlink, readdir, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";

const workspace =
  process.env.NODE_ENV === "test" && process.env.REDDONE_VERIFY_WORKSPACE
    ? path.resolve(process.env.REDDONE_VERIFY_WORKSPACE)
    : "/workspace";
const source = path.join(workspace, ".vercel/output");
const destination = path.join(workspace, ".reddone-runtime/release-output-materialized");
const sourceReal = await realpath(source);
const maximumFiles = 20_000;
const maximumBytes = 192 * 1024 * 1024;
const maximumFileBytes = 10 * 1024 * 1024;

function inside(root, candidate) {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

async function inspectSource(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const candidate = path.join(directory, entry.name);
    const details = await lstat(candidate);
    if (details.isSymbolicLink()) {
      const target = await readlink(candidate);
      if (!target || path.isAbsolute(target) || target.includes("\0")) throw new Error(`Unsafe Build Output link: ${candidate}`);
      const lexicalTarget = path.resolve(path.dirname(candidate), target);
      if (!inside(source, lexicalTarget)) throw new Error(`Build Output link escaped its root: ${candidate}`);
      const resolvedTarget = await realpath(lexicalTarget);
      if (!inside(sourceReal, resolvedTarget)) throw new Error(`Build Output link resolved outside its root: ${candidate}`);
      const targetDetails = await lstat(resolvedTarget);
      if (!targetDetails.isFile() && !targetDetails.isDirectory()) throw new Error(`Build Output link targets a special file: ${candidate}`);
      continue;
    }
    if (details.isDirectory()) await inspectSource(candidate);
    else if (!details.isFile()) throw new Error(`Special Build Output entry rejected: ${candidate}`);
  }
}

async function inspectMaterialized(directory, totals) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const candidate = path.join(directory, entry.name);
    const details = await lstat(candidate);
    if (details.isDirectory()) {
      await inspectMaterialized(candidate, totals);
      continue;
    }
    if (!details.isFile() || details.isSymbolicLink() || details.nlink !== 1) {
      throw new Error(`Materialized Build Output contains a link or special entry: ${candidate}`);
    }
    if (details.size > maximumFileBytes) throw new Error(`Materialized Build Output file exceeds 10 MiB: ${candidate}`);
    totals.files += 1;
    totals.bytes += details.size;
    if (totals.files > maximumFiles || totals.bytes > maximumBytes) {
      throw new Error("Materialized Build Output exceeds the 20,000-file or 192-MiB cap.");
    }
  }
}

await inspectSource(source);
await rm(destination, { recursive: true, force: true });
await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
await cp(source, destination, { recursive: true, dereference: true, errorOnExist: true, force: false });
const totals = { files: 0, bytes: 0 };
await inspectMaterialized(destination, totals);
await rm(source, { recursive: true, force: true });
await rename(destination, source);
process.stdout.write(`materialized ${totals.files} regular files (${totals.bytes} bytes)\n`);
