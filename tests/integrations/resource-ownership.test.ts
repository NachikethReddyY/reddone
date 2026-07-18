import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const githubMocks = vi.hoisted(() => ({
  get: vi.fn(),
  createInOrg: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@octokit/auth-app", () => ({
  createAppAuth: () => async () => ({ token: "installation-token" }),
}));
vi.mock("@octokit/rest", () => ({
  Octokit: class {
    repos = githubMocks;
  },
}));

import { reconcilePrivateRepository } from "@/integrations/github";
import {
  reconcileVercelProject,
  REDDONE_VERCEL_OWNERSHIP_ENV_KEY,
} from "@/integrations/vercel";
import {
  collisionResistantResourceName,
  resourceOwnershipMarker,
} from "@/policy/resource-ownership";

const workspaceId = "019f4f17-1fc3-7fa1-9eaa-624e8f87b2be";
const projectId = "019f4f17-1fc3-7fa1-9eaa-624e8f87b2bf";
const githubMarker = resourceOwnershipMarker({ provider: "github", workspaceId, projectId });
const vercelMarker = resourceOwnershipMarker({ provider: "vercel", workspaceId, projectId });
const githubName = collisionResistantResourceName("latepay-copilot", githubMarker);
const vercelName = collisionResistantResourceName("latepay-copilot", vercelMarker);
const githubConfig = { appId: "123", privateKey: "private-key", installationId: "456" };

beforeEach(() => {
  githubMocks.get.mockReset();
  githubMocks.createInOrg.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("collision-resistant external resource ownership", () => {
  it("derives stable provider-specific names that differ across projects", () => {
    const otherMarker = resourceOwnershipMarker({
      provider: "github",
      workspaceId,
      projectId: "019f4f17-1fc3-7fa1-9eaa-624e8f87b2c0",
    });
    expect(githubMarker).toMatch(/^reddone-v1-github-[a-f0-9]{24}$/);
    expect(vercelMarker).toMatch(/^reddone-v1-vercel-[a-f0-9]{24}$/);
    expect(githubName).not.toBe(collisionResistantResourceName("latepay-copilot", otherMarker));
    expect(githubName.length).toBeLessThanOrEqual(100);
  });

  it("rejects an unrelated private GitHub repository before mutation", async () => {
    githubMocks.get.mockResolvedValue({
      data: { id: 100, private: true, description: "owned elsewhere", full_name: `acme/${githubName}`, html_url: "https://github.com/acme/repo" },
    });

    await expect(
      reconcilePrivateRepository(githubConfig, {
        owner: "acme",
        name: githubName,
        ownershipMarker: githubMarker,
        expectedExternalRepositoryId: null,
      }),
    ).rejects.toThrow(/unrelated resource/i);
    expect(githubMocks.get).toHaveBeenCalledTimes(1);
    expect(githubMocks.createInOrg).not.toHaveBeenCalled();
  });

  it("reuses a GitHub repository by exact binding even if its description changed", async () => {
    githubMocks.get.mockResolvedValue({
      data: { id: 100, private: true, description: "Owner edited", full_name: `acme/${githubName}`, html_url: "https://github.com/acme/repo" },
    });

    await expect(
      reconcilePrivateRepository(githubConfig, {
        owner: "acme",
        name: githubName,
        ownershipMarker: githubMarker,
        expectedExternalRepositoryId: "100",
      }),
    ).resolves.toMatchObject({ id: "100", created: false });
    expect(githubMocks.createInOrg).not.toHaveBeenCalled();
  });

  it("reuses an atomically marked GitHub repository after a create timeout", async () => {
    githubMocks.get.mockResolvedValue({
      data: { id: 101, private: true, description: githubMarker, full_name: `acme/${githubName}`, html_url: "https://github.com/acme/repo" },
    });

    await expect(
      reconcilePrivateRepository(githubConfig, {
        owner: "acme",
        name: githubName,
        ownershipMarker: githubMarker,
        expectedExternalRepositoryId: null,
      }),
    ).resolves.toMatchObject({ id: "101", created: false });
    expect(githubMocks.createInOrg).not.toHaveBeenCalled();
  });

  it("creates a missing GitHub repository with the exact ownership marker", async () => {
    githubMocks.get.mockRejectedValue(Object.assign(new Error("not found"), { status: 404 }));
    githubMocks.createInOrg.mockResolvedValue({
      data: { id: 102, full_name: `acme/${githubName}`, html_url: "https://github.com/acme/repo" },
    });

    await reconcilePrivateRepository(githubConfig, {
      owner: "acme",
      name: githubName,
      ownershipMarker: githubMarker,
      expectedExternalRepositoryId: null,
    });
    expect(githubMocks.createInOrg).toHaveBeenCalledWith(expect.objectContaining({
      name: githubName,
      description: githubMarker,
      private: true,
      auto_init: false,
    }));
  });

  it("rejects an unrelated same-name Vercel project before mutation", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "prj_unrelated", name: vercelName }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({
          envs: [{
            key: REDDONE_VERCEL_OWNERSHIP_ENV_KEY,
            value: "reddone-v1-vercel-000000000000000000000000",
            type: "plain",
            target: ["production", "preview"],
          }],
        }), { status: 200 }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(reconcileVercelProject({
      accessToken: "vercel-token",
      teamId: "team_1",
      name: vercelName,
      ownershipMarker: vercelMarker,
      expectedExternalProjectId: null,
    })).rejects.toThrow(/unrelated resource/i);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.every((call) => !call[1]?.method || call[1]?.method === "GET")).toBe(true);
  });

  it("reuses a Vercel project by exact canonical external ID", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ id: "prj_bound", name: "owner-renamed-project" }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(reconcileVercelProject({
      accessToken: "vercel-token",
      teamId: "team_1",
      name: vercelName,
      ownershipMarker: vercelMarker,
      expectedExternalProjectId: "prj_bound",
    })).resolves.toMatchObject({ id: "prj_bound", created: false });
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/projects/prj_bound?");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reuses an atomically marked Vercel project after a create timeout", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "prj_retry", name: vercelName }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({
          envs: [{
            key: REDDONE_VERCEL_OWNERSHIP_ENV_KEY,
            value: vercelMarker,
            type: "plain",
            target: ["preview", "production"],
          }],
        }), { status: 200 }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(reconcileVercelProject({
      accessToken: "vercel-token",
      teamId: "team_1",
      name: vercelName,
      ownershipMarker: vercelMarker,
      expectedExternalProjectId: null,
    })).resolves.toMatchObject({ id: "prj_retry", created: false });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("creates a missing Vercel project with its ownership marker atomically", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("not found", { status: 404 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "prj_new", name: vercelName }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await reconcileVercelProject({
      accessToken: "vercel-token",
      teamId: "team_1",
      name: vercelName,
      ownershipMarker: vercelMarker,
      expectedExternalProjectId: null,
    });
    const createRequest = fetchMock.mock.calls[1]?.[1];
    expect(createRequest).toMatchObject({ method: "POST" });
    const body = JSON.parse(String(createRequest?.body)) as { environmentVariables?: Array<Record<string, unknown>> };
    expect(body.environmentVariables).toEqual([{
      key: REDDONE_VERCEL_OWNERSHIP_ENV_KEY,
      value: vercelMarker,
      type: "plain",
      target: ["production", "preview"],
    }]);
  });
});

