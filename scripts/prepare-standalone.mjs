import { cp, mkdir, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

const projectRoot = process.cwd();
const standaloneRoot = join(projectRoot, ".next", "standalone");

async function copyIfPresent(source, destination) {
  try {
    await stat(source);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return;
    throw error;
  }

  await rm(destination, { force: true, recursive: true });
  await mkdir(dirname(destination), { recursive: true });
  await cp(source, destination, { recursive: true });
}

// Next.js deliberately omits these runtime assets from its standalone trace.
// Copy them explicitly so `node .next/standalone/server.js` works on Railway.
await copyIfPresent(join(projectRoot, "public"), join(standaloneRoot, "public"));
await copyIfPresent(join(projectRoot, ".next", "static"), join(standaloneRoot, ".next", "static"));
