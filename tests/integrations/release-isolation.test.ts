import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { verifierGates } from "@/integrations/daytona";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("release-process isolation", () => {
  it("keeps the Vercel CLI and subprocess primitives out of the runtime integration", async () => {
    const integration = await readFile(path.resolve(process.cwd(), "src/integrations/vercel-release.ts"), "utf8");
    expect(integration).not.toContain('from "node:child_process"');
    expect(integration).not.toContain("require.resolve");
    expect(integration).not.toContain("vercel/dist/index.js");
    expect(integration).not.toContain("VERCEL_TOKEN:");
  });

  it("accepts the safe generated starter and rejects filesystem and route primitives", async () => {
    const fixture = await mkdtemp(path.join(tmpdir(), "reddone-sast-"));
    temporaryDirectories.push(fixture);
    for (const directory of [
      "src/app/generated",
      "src/components/generated",
      "src/content",
      "public/generated",
    ]) {
      await mkdir(path.join(fixture, directory), { recursive: true });
    }
    await writeFile(path.join(fixture, "src/app/generated/app.css"), ".shell { color: #fff; }", "utf8");
    const componentPath = path.join(fixture, "src/components/generated/application.tsx");
    await writeFile(
      componentPath,
      'export function GeneratedApplication() { return <main aria-label="Safe app">Ready</main>; }',
      "utf8",
    );

    const script = path.resolve(process.cwd(), "infrastructure/daytona/verify/sast.mjs");
    const environment: NodeJS.ProcessEnv = {
      NODE_ENV: "test",
      REDDONE_WORKSPACE: fixture,
      REDDONE_TYPESCRIPT_PATH: path.resolve(process.cwd(), "node_modules/typescript/lib/typescript.js"),
    };
    const safe = await execFileAsync(process.execPath, [script], { env: environment, encoding: "utf8" });
    expect(safe.stdout).toContain("policy passed");

    await writeFile(
      componentPath,
      'import fs from "node:fs"; export function GeneratedApplication() { return <main>{process.env.SECRET}{fs}</main>; }',
      "utf8",
    );
    await expect(execFileAsync(process.execPath, [script], { env: environment, encoding: "utf8" })).rejects.toMatchObject({
      stderr: expect.stringMatching(/package import is not allowlisted|forbidden runtime primitive/),
    });

    await writeFile(componentPath, "export function GeneratedApplication() { return <main>Ready</main>; }", "utf8");
    const routePath = path.join(fixture, "src/app/generated/route.ts");
    await writeFile(routePath, "export const GET = () => new Response('no');", "utf8");
    await expect(execFileAsync(process.execPath, [script], { env: environment, encoding: "utf8" })).rejects.toMatchObject({
      stderr: expect.stringMatching(/routes and server modules are protected/),
    });

    await rm(routePath);
    const shadowPackage = path.join(fixture, "src/components/generated/node_modules/react");
    await mkdir(shadowPackage, { recursive: true });
    await writeFile(path.join(shadowPackage, "index.ts"), "export const shadowed = true;", "utf8");
    await expect(execFileAsync(process.execPath, [script], { env: environment, encoding: "utf8" })).rejects.toMatchObject({
      stderr: expect.stringMatching(/package-resolution/),
    });
  });

  it("keeps the workspace and generated source immutable while trusted code executes", async () => {
    const dockerfile = await readFile(path.resolve(process.cwd(), "infrastructure/daytona/Dockerfile"), "utf8");
    const gateRunner = await readFile(path.resolve(process.cwd(), "infrastructure/daytona/verify/run-gate"), "utf8");
    const host = await readFile(
      path.resolve(process.cwd(), "templates/generated-next-app/src/components/generated-host.tsx"),
      "utf8",
    );

    expect(dockerfile).toContain("chmod 0555 /workspace");
    expect(dockerfile).toContain("chmod 4555 /opt/reddone/bin/seal-generated");
    expect(dockerfile).not.toContain("chown -R node:node /workspace;");
    expect(gateRunner).toContain("/opt/reddone/bin/seal-generated");
    expect(gateRunner.indexOf("seal-generated")).toBeLessThan(gateRunner.indexOf("assert-immutable"));
    expect(host.trimStart()).toMatch(/^"use client";/);
    expect(verifierGates.indexOf("production_build")).toBeLessThan(verifierGates.indexOf("playwright"));
  });

  it("builds a portable release offline and materializes every Vercel output link before export", async () => {
    const [build, project, materializer, validator, dockerfile] = await Promise.all([
      readFile(path.resolve(process.cwd(), "infrastructure/daytona/verify/production-build"), "utf8"),
      readFile(path.resolve(process.cwd(), "templates/generated-next-app/.vercel/project.json"), "utf8"),
      readFile(path.resolve(process.cwd(), "infrastructure/daytona/verify/materialize-build-output.mjs"), "utf8"),
      readFile(path.resolve(process.cwd(), "infrastructure/daytona/verify/validate-build-output.mjs"), "utf8"),
      readFile(path.resolve(process.cwd(), "infrastructure/daytona/Dockerfile"), "utf8"),
    ]);

    expect(build).toContain("vercel build --standalone --no-color");
    expect(build).not.toContain("vercel build --yes");
    expect(build).toContain("next build --webpack");
    expect(build).toContain("materialize-build-output.mjs");
    expect(build.indexOf("materialize-build-output.mjs")).toBeLessThan(build.indexOf("validate-build-output.mjs release\n"));
    expect(JSON.parse(project)).toMatchObject({
      orgId: "org_reddone_offline_build",
      projectId: "prj_reddone_offline_build",
      settings: { installCommand: "true", buildCommand: "./node_modules/.bin/next build --webpack", nodeVersion: "24.x" },
    });
    expect(materializer).toContain("path.isAbsolute(target)");
    expect(materializer).toContain("realpath(lexicalTarget)");
    expect(materializer).toContain("details.nlink !== 1");
    expect(materializer).toContain("192 * 1024 * 1024");
    expect(validator).toContain('config.runtime !== "nodejs24.x"');
    expect(validator).toContain('"filePathMap" in config');
    expect(dockerfile).toContain("chmod 1777 /workspace/.vercel");
    expect(dockerfile).not.toContain("-o -path './.vercel' \\");
  });

  it("keeps release health runtime-bound while building static preview from a separate source copy", async () => {
    const healthRoute = await readFile(
      path.resolve(process.cwd(), "templates/generated-next-app/src/app/api/health/route.ts"),
      "utf8",
    );
    const productionBuild = await readFile(
      path.resolve(process.cwd(), "infrastructure/daytona/verify/production-build"),
      "utf8",
    );

    expect(healthRoute).toContain('dynamic = "force-dynamic"');
    expect(healthRoute).toContain("process.env.REDDONE_ARTIFACT_HASH");
    expect(productionBuild).toContain("mktemp -d /tmp/reddone-static-preview");
    expect(productionBuild).toContain('rm -rf "$preview_source/src/app/api/health"');
    expect(productionBuild).toContain("release_health_hash");
    expect(productionBuild).toContain("sha256sum /workspace/src/app/api/health/route.ts");
  });
});
