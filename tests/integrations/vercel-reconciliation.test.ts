import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  assertDeploymentHealthy,
  buildPrebuiltDeploymentRequest,
  deployPrebuiltPreview,
  planVercelRuntimeEnvironment,
  promoteDeployment,
  reconcileSensitiveRuntimeVariables,
  REDDONE_RUNTIME_ENV_COMMENT,
  type VercelRuntimeEnvironmentRecord,
} from "@/integrations/vercel-release";
import {
  parseVercelDeploymentPage,
  parseVercelInstallationCompletionUrl,
  reconcileRecentVercelDeployment,
  REDDONE_VERCEL_ARTIFACT_META_KEY,
  REDDONE_VERCEL_RUN_META_KEY,
  requireVercelTeamInstallation,
  testVercelConnection,
  createVercelAuthorizationUrl,
} from "@/integrations/vercel";

const runId = "019f4f17-1fc3-7fa1-9eaa-624e8f87b2be";
const artifactHash = "a".repeat(64);
const metadata = { runId, artifactHash };
const temporaryDirectories: string[] = [];

function sha1(value: string) {
  return createHash("sha1").update(value).digest("hex");
}

async function makePrebuiltFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "reddone-vercel-api-"));
  temporaryDirectories.push(root);
  await mkdir(path.join(root, ".vercel", "output", "static"), { recursive: true });
  await writeFile(
    path.join(root, ".vercel", "project.json"),
    JSON.stringify({ orgId: "team_1", projectId: "prj_1", projectName: "reddone-test" }),
    "utf8",
  );
  await writeFile(path.join(root, ".vercel", "output", "config.json"), JSON.stringify({ version: 3 }), "utf8");
  await writeFile(path.join(root, ".vercel", "output", "static", "index.txt"), "verified output", "utf8");
  return root;
}

function runtimeVariable(
  input: Partial<VercelRuntimeEnvironmentRecord> & Pick<VercelRuntimeEnvironmentRecord, "id" | "key">,
): VercelRuntimeEnvironmentRecord {
  return {
    type: "sensitive",
    targets: ["production"],
    comment: REDDONE_RUNTIME_ENV_COMMENT,
    gitBranch: null,
    customEnvironmentIds: [],
    ...input,
  };
}

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Vercel prebuilt deployment reconciliation", () => {
  it("uses the configured integration slug and accepts only Vercel completion URLs", () => {
    const authorization = new URL(createVercelAuthorizationUrl({
      state: "state-value",
      environment: { VERCEL_INTEGRATION_SLUG: "reddone-test" },
    }));
    expect(authorization.toString()).toContain("https://vercel.com/integrations/reddone-test/new");
    expect(authorization.searchParams.get("state")).toBe("state-value");
    expect(parseVercelInstallationCompletionUrl("https://vercel.com/dashboard/integrations?done=1")?.hostname).toBe("vercel.com");
    expect(() => parseVercelInstallationCompletionUrl("https://attacker.example/continue")).toThrow(/untrusted/i);
  });

  it("builds a fixed prebuilt API request with only stable non-secret runtime metadata", () => {
    const body = buildPrebuiltDeploymentRequest({
      projectId: "prj_1",
      projectName: "reddone-test",
      metadata,
      files: [{ file: ".vercel/output/config.json", sha: "1".repeat(40), size: 13 }],
    });
    expect(body).toEqual({
      version: 2,
      source: "cli",
      name: "reddone-test",
      project: "prj_1",
      meta: {
        [REDDONE_VERCEL_RUN_META_KEY]: runId,
        [REDDONE_VERCEL_ARTIFACT_META_KEY]: artifactHash,
      },
      files: [{ file: ".vercel/output/config.json", sha: "1".repeat(40), size: 13 }],
      env: { REDDONE_ARTIFACT_HASH: artifactHash },
    });
    expect(body).not.toHaveProperty("build");
    expect(body).not.toHaveProperty("buildEnv");
    expect(JSON.stringify(body)).not.toMatch(/token|secret/i);
  });

  it("uploads only requested SHA-1 files, then creates the same prebuilt deployment", async () => {
    const root = await makePrebuiltFixture();
    const config = JSON.stringify({ version: 3 });
    const configHash = sha1(config);
    const staticHash = sha1("verified output");
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ error: { code: "missing_files", message: "Missing files", missing: [staticHash, configHash] } }),
          { status: 400, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(new Response("{}", { status: 200 }))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "dpl_1", url: "reddone-test-abc.vercel.app" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      deployPrebuiltPreview({ token: "vercel-access-token", teamId: "team_1", projectId: "prj_1", cwd: root }, metadata),
    ).resolves.toBe("https://reddone-test-abc.vercel.app");

    expect(fetchMock).toHaveBeenCalledTimes(4);
    const creationCalls = fetchMock.mock.calls.filter(([request]) => new URL(String(request)).pathname === "/v13/deployments");
    expect(creationCalls).toHaveLength(2);
    for (const [request, init] of creationCalls) {
      const url = new URL(String(request));
      expect(url.searchParams.get("teamId")).toBe("team_1");
      expect(url.searchParams.get("prebuilt")).toBe("1");
      expect(url.toString()).not.toContain("vercel-access-token");
      const requestBody = JSON.parse(String(init?.body));
      expect(requestBody).toMatchObject({
        version: 2,
        source: "cli",
        name: "reddone-test",
        project: "prj_1",
        env: { REDDONE_ARTIFACT_HASH: artifactHash },
      });
      expect(requestBody.files).toEqual([
        { file: ".vercel/output/config.json", sha: configHash, size: Buffer.byteLength(config) },
        { file: ".vercel/output/static/index.txt", sha: staticHash, size: Buffer.byteLength("verified output") },
      ]);
      expect(requestBody).not.toHaveProperty("build");
      expect(requestBody).not.toHaveProperty("buildEnv");
    }

    const uploads = fetchMock.mock.calls.filter(([request]) => new URL(String(request)).pathname === "/v2/files");
    expect(uploads).toHaveLength(2);
    expect(new Set(uploads.map(([, init]) => new Headers(init?.headers).get("x-vercel-digest")))).toEqual(
      new Set([configHash, staticHash]),
    );
    for (const [request, init] of uploads) {
      expect(new URL(String(request)).searchParams.get("teamId")).toBe("team_1");
      const headers = new Headers(init?.headers);
      expect(headers.get("x-vercel-digest")).toBe(headers.get("x-now-digest"));
      expect(headers.get("content-length")).toBe(headers.get("x-now-size"));
      expect(headers.has("x-vercel-size")).toBe(false);
      expect(Buffer.byteLength(init?.body as Buffer)).toBe(Number(headers.get("content-length")));
    }
  });

  it("retries a requested content-addressed upload, but fails closed on unknown or repeated missing hashes", async () => {
    const root = await makePrebuiltFixture();
    const configHash = sha1(JSON.stringify({ version: 3 }));
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { code: "missing_files", missing: [configHash] } }), { status: 400 }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: "temporary" } }), { status: 503 }))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "dpl_retry", url: "retry.vercel.app" }), { status: 200 }),
      );
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      deployPrebuiltPreview({ token: "token", teamId: "team_1", projectId: "prj_1", cwd: root }, metadata),
    ).resolves.toBe("https://retry.vercel.app");
    expect(fetchMock).toHaveBeenCalledTimes(4);

    fetchMock.mockReset().mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { code: "missing_files", missing: ["f".repeat(40)] } }), { status: 400 }),
    );
    await expect(
      deployPrebuiltPreview({ token: "token", teamId: "team_1", projectId: "prj_1", cwd: root }, metadata),
    ).rejects.toThrow(/unknown or duplicate/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock
      .mockReset()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { code: "missing_files", missing: [configHash] } }), { status: 400 }),
      )
      .mockResolvedValueOnce(new Response("{}", { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { code: "missing_files", missing: [configHash] } }), { status: 400 }),
      );
    await expect(
      deployPrebuiltPreview({ token: "token", teamId: "team_1", projectId: "prj_1", cwd: root }, metadata),
    ).rejects.toThrow(/still reported missing/i);
  });

  it("rejects a non-Vercel deployment URL and an output linked to another project", async () => {
    const root = await makePrebuiltFixture();
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ id: "dpl_bad", url: "https://attacker.example" }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      deployPrebuiltPreview({ token: "token", teamId: "team_1", projectId: "prj_1", cwd: root }, metadata),
    ).rejects.toThrow(/invalid deployment URL/i);

    await expect(
      deployPrebuiltPreview({ token: "token", teamId: "team_1", projectId: "prj_other", cwd: root }, metadata),
    ).rejects.toThrow(/different project/i);

  });

  // Creating a file symlink requires Developer Mode or elevation on Windows.
  it.skipIf(process.platform === "win32")("rejects a symlinked Vercel output file", async () => {
    const linkedRoot = await makePrebuiltFixture();
    await symlink("config.json", path.join(linkedRoot, ".vercel", "output", "linked-config.json"));
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      deployPrebuiltPreview({ token: "token", teamId: "team_1", projectId: "prj_1", cwd: linkedRoot }, metadata),
    ).rejects.toThrow(/non-regular filesystem entry/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("promotes the exact resolved deployment through the REST API without a rebuild", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ id: "dpl_approved", url: "approved.vercel.app", projectId: "prj_1" }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      promoteDeployment(
        { token: "vercel-access-token", teamId: "team_1", projectId: "prj_1", cwd: "/unused" },
        "https://approved.vercel.app",
      ),
    ).resolves.toEqual({ promoted: true, previewUrl: "https://approved.vercel.app" });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const lookup = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(lookup.pathname).toBe("/v13/deployments/approved.vercel.app");
    expect(lookup.searchParams.get("teamId")).toBe("team_1");
    const promote = new URL(String(fetchMock.mock.calls[1]?.[0]));
    expect(promote.pathname).toBe("/v10/projects/prj_1/promote/dpl_approved");
    expect(promote.searchParams.get("teamId")).toBe("team_1");
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ method: "POST", body: "{}" });

    fetchMock.mockReset().mockResolvedValueOnce(
      new Response(JSON.stringify({ id: "dpl_wrong", url: "approved.vercel.app", projectId: "prj_other" }), {
        status: 200,
      }),
    );
    await expect(
      promoteDeployment(
        { token: "token", teamId: "team_1", projectId: "prj_1", cwd: "/unused" },
        "https://approved.vercel.app",
      ),
    ).rejects.toThrow(/different deployment/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("accepts only a non-redirecting 200 JSON health response for the approved artifact", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ status: "ok", artifactHash }), {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(assertDeploymentHealthy("https://candidate.vercel.app", artifactHash)).resolves.toEqual({
      ok: true,
      status: 200,
      artifactHash,
    });
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ redirect: "manual", cache: "no-store" });

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ status: "ok", artifactHash: "b".repeat(64) }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    await expect(assertDeploymentHealthy("https://candidate.vercel.app", artifactHash)).rejects.toThrow(/approved artifact/i);

    fetchMock.mockResolvedValueOnce(
      new Response(null, { status: 307, headers: { location: "https://other.vercel.app/api/health" } }),
    );
    await expect(assertDeploymentHealthy("https://candidate.vercel.app", artifactHash)).rejects.toThrow(/health check/i);
  });

  it("matches both metadata values and the requested project exactly", () => {
    const page = parseVercelDeploymentPage(
      {
        deployments: [
          {
            uid: "dpl_wrong_run",
            url: "wrong-run.vercel.app",
            projectId: "prj_1",
            meta: { [REDDONE_VERCEL_RUN_META_KEY]: "019f4f17-1fc3-7fa1-9eaa-624e8f87b2bf", [REDDONE_VERCEL_ARTIFACT_META_KEY]: artifactHash },
          },
          {
            uid: "dpl_wrong_project",
            url: "wrong-project.vercel.app",
            projectId: "prj_other",
            meta: { [REDDONE_VERCEL_RUN_META_KEY]: runId, [REDDONE_VERCEL_ARTIFACT_META_KEY]: artifactHash },
          },
          {
            uid: "dpl_exact",
            url: "exact.vercel.app",
            projectId: "prj_1",
            readyState: "READY",
            meta: {
              [REDDONE_VERCEL_RUN_META_KEY]: runId,
              [REDDONE_VERCEL_ARTIFACT_META_KEY]: artifactHash,
              providerOwnedMetadata: "allowed",
            },
          },
        ],
        pagination: { next: null },
      },
      { projectId: "prj_1", metadata },
    );

    expect(page.deployment).toEqual({ id: "dpl_exact", url: "https://exact.vercel.app", state: "READY" });
  });

  it("uses the v7 project list and follows pagination before returning an exact match", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ deployments: [], pagination: { next: 1_720_000_000_000 } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            deployments: [
              {
                uid: "dpl_reconciled",
                url: "reconciled.vercel.app",
                projectId: "prj_1",
                meta: { [REDDONE_VERCEL_RUN_META_KEY]: runId, [REDDONE_VERCEL_ARTIFACT_META_KEY]: artifactHash },
              },
            ],
            pagination: { next: null },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      reconcileRecentVercelDeployment({
        accessToken: "vercel-access-token",
        teamId: "team_1",
        projectId: "prj_1",
        metadata,
        since: new Date("2026-07-11T00:00:00.000Z"),
      }),
    ).resolves.toEqual({ id: "dpl_reconciled", url: "https://reconciled.vercel.app", state: undefined });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstUrl = new URL(String(fetchMock.mock.calls[0]?.[0]));
    const secondUrl = new URL(String(fetchMock.mock.calls[1]?.[0]));
    expect(firstUrl.pathname).toBe("/v7/deployments");
    expect(firstUrl.searchParams.get("projectId")).toBe("prj_1");
    expect(firstUrl.searchParams.get("teamId")).toBe("team_1");
    expect(firstUrl.searchParams.get("since")).toBe(String(new Date("2026-07-10T23:59:00.000Z").getTime()));
    expect(secondUrl.searchParams.get("until")).toBe("1720000000000");
    expect(firstUrl.toString()).not.toContain("vercel-access-token");
  });
});

describe("Vercel team installation identity", () => {
  it("requires a team installation and enforces an optional workspace team", () => {
    expect(() => requireVercelTeamInstallation({ teamId: null })).toThrow(/installed on a team/i);
    expect(() => requireVercelTeamInstallation({ teamId: "user_123" })).toThrow(/installed on a team/i);
    expect(() =>
      requireVercelTeamInstallation({ teamId: "team_installed", allowedTeamId: "team_other" }),
    ).toThrow(/different team/i);
    expect(requireVercelTeamInstallation({ teamId: "team_installed", allowedTeamId: "team_installed" })).toBe(
      "team_installed",
    );
  });

  it("tests the installed team resource and preserves that exact team ID", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ id: "team_installed", slug: "workspace-team", name: "Workspace Team" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(testVercelConnection("vercel-token", "team_installed")).resolves.toEqual({
      ok: true,
      accountId: "team_installed",
      account: "Workspace Team",
    });
    const requestUrl = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(requestUrl.pathname).toBe("/v2/teams/team_installed");
    expect(requestUrl.searchParams.get("teamId")).toBe("team_installed");
    expect(requestUrl.pathname).not.toContain("user");
  });

  it("rejects a provider response for a different team instead of replacing the stored ID", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(JSON.stringify({ id: "team_other", slug: "other-team", name: "Other Team" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    await expect(testVercelConnection("vercel-token", "team_installed")).rejects.toThrow(/different team/i);
  });
});

describe("Vercel exact runtime secret reconciliation", () => {
  it("deletes stale managed entries while preserving owner-managed variables", () => {
    const owner = runtimeVariable({ id: "env_owner", key: "OWNER_ONLY", comment: "Created by workspace owner" });
    const stale = runtimeVariable({ id: "env_stale", key: "REVOKED_TOKEN" });
    const current = runtimeVariable({ id: "env_current", key: "APP_TOKEN" });

    const plan = planVercelRuntimeEnvironment({
      existing: [owner, stale, current],
      desiredKeys: ["APP_TOKEN"],
      target: "production",
    });

    expect(plan.deleteEntries.map((variable) => variable.id)).toEqual(["env_stale"]);
    expect(plan.keptKeys).toEqual(["APP_TOKEN"]);
    expect(plan.deleteEntries).not.toContainEqual(expect.objectContaining({ id: "env_owner" }));
  });

  it("rejects a desired key collision with any non-ReDDone variable", () => {
    const owner = runtimeVariable({ id: "env_owner", key: "APP_TOKEN", comment: null, type: "encrypted" });
    expect(() =>
      planVercelRuntimeEnvironment({ existing: [owner], desiredKeys: ["APP_TOKEN"], target: "production" }),
    ).toThrow(/owner-managed key collisions: APP_TOKEN/i);
  });

  it("reserves deployment identity names from project secret grants", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    await expect(reconcileSensitiveRuntimeVariables({
      token: "vercel-token",
      teamId: "team_1",
      projectId: "prj_1",
      target: "production",
      variables: [{ key: "REDDONE_ARTIFACT_HASH", value: "must-not-shadow-identity" }],
    })).rejects.toThrow(/deployment identity keys/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("deletes stale managed keys, upserts the exact approved set, and verifies convergence", async () => {
    const owner = { id: "env_owner", key: "OWNER_ONLY", type: "encrypted", target: ["production"], comment: "Owner" };
    const stale = {
      id: "env_stale",
      key: "REVOKED_TOKEN",
      type: "sensitive",
      target: ["production"],
      comment: REDDONE_RUNTIME_ENV_COMMENT,
    };
    const desiredInventory = [
      owner,
      {
        id: "env_app",
        key: "APP_TOKEN",
        type: "sensitive",
        target: ["production"],
        comment: REDDONE_RUNTIME_ENV_COMMENT,
      },
      {
        id: "env_api",
        key: "API_KEY",
        type: "sensitive",
        target: ["production"],
        comment: REDDONE_RUNTIME_ENV_COMMENT,
      },
    ];
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ envs: [owner, stale], hiddenProductionEnvCount: 0 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "env_app" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "env_api" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ envs: desiredInventory, hiddenProductionEnvCount: 0 }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      reconcileSensitiveRuntimeVariables({
        token: "vercel-token",
        teamId: "team_1",
        projectId: "prj_1",
        target: "production",
        variables: [
          { key: "APP_TOKEN", value: "app-secret-value" },
          { key: "API_KEY", value: "api-secret-value" },
        ],
      }),
    ).resolves.toEqual({ removedKeys: ["REVOKED_TOKEN"], upsertedKeys: ["API_KEY", "APP_TOKEN"] });

    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ method: "DELETE" });
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("/env/env_stale?");
    expect(String(fetchMock.mock.calls[1]?.[0])).not.toContain("env_owner");
    for (const callIndex of [2, 3]) {
      const request = fetchMock.mock.calls[callIndex]?.[1];
      expect(request).toMatchObject({ method: "POST" });
      const body = JSON.parse(String(request?.body)) as Record<string, unknown>;
      expect(body).toMatchObject({ type: "sensitive", target: ["production"], comment: REDDONE_RUNTIME_ENV_COMMENT });
    }
  });

  it.each([
    {
      name: "inventory",
      responses: [new Response("unavailable", { status: 503 })],
      variables: [] as { key: string; value: string }[],
      expectedCalls: 1,
    },
    {
      name: "stale deletion",
      responses: [
        new Response(
          JSON.stringify({
            envs: [
              {
                id: "env_stale",
                key: "STALE_KEY",
                type: "sensitive",
                target: ["production"],
                comment: REDDONE_RUNTIME_ENV_COMMENT,
              },
            ],
          }),
          { status: 200 },
        ),
        new Response("unavailable", { status: 503 }),
      ],
      variables: [] as { key: string; value: string }[],
      expectedCalls: 2,
    },
    {
      name: "approved upsert",
      responses: [
        new Response(JSON.stringify({ envs: [] }), { status: 200 }),
        new Response("unavailable", { status: 503 }),
      ],
      variables: [{ key: "APP_TOKEN", value: "secret" }],
      expectedCalls: 2,
    },
    {
      name: "post-write verification",
      responses: [
        new Response(JSON.stringify({ envs: [] }), { status: 200 }),
        new Response(JSON.stringify({ id: "env_app" }), { status: 200 }),
        new Response("unavailable", { status: 503 }),
      ],
      variables: [{ key: "APP_TOKEN", value: "secret" }],
      expectedCalls: 3,
    },
  ])("fails closed on $name provider failure", async ({ responses, variables, expectedCalls }) => {
    const fetchMock = vi.fn<typeof fetch>();
    for (const response of responses) fetchMock.mockResolvedValueOnce(response);
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      reconcileSensitiveRuntimeVariables({
        token: "vercel-token",
        teamId: "team_1",
        projectId: "prj_1",
        target: "production",
        variables,
      }),
    ).rejects.toThrow(/Vercel/i);
    expect(fetchMock).toHaveBeenCalledTimes(expectedCalls);
  });
});
