import "server-only";

import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";

import { assertCollisionResistantResourceName } from "@/policy/resource-ownership";
import { IntegrationError } from "./errors";

export interface GitHubAppConfig {
  appId: string;
  privateKey: string;
  installationId: string;
}

async function installationClient(config: GitHubAppConfig) {
  const auth = createAppAuth({ appId: config.appId, privateKey: config.privateKey });
  const token = await auth({ type: "installation", installationId: config.installationId });
  return new Octokit({ auth: token.token });
}

export async function testGitHubInstallation(config: GitHubAppConfig) {
  try {
    const client = await installationClient(config);
    const installation = await client.apps.getInstallation({ installation_id: Number(config.installationId) });
    const permissions = installation.data.permissions;
    if (permissions.administration !== "write" || permissions.contents !== "write" || permissions.metadata !== "read") {
      throw new IntegrationError("provider_error", "The GitHub App installation is missing administration, contents, or metadata scope.", false, 403);
    }
    return {
      ok: true as const,
      account: installation.data.account && "login" in installation.data.account ? installation.data.account.login : "GitHub",
      scopes: ["administration:write", "contents:write", "metadata:read"],
    };
  } catch {
    throw new IntegrationError("provider_error", "The GitHub App installation is unavailable or missing scope.", false, 400);
  }
}

export async function reconcilePrivateRepository(
  config: GitHubAppConfig,
  input: {
    owner: string;
    name: string;
    ownershipMarker: string;
    expectedExternalRepositoryId: string | null;
  },
) {
  if (input.expectedExternalRepositoryId === null) {
    assertCollisionResistantResourceName(input.name, input.ownershipMarker);
  }
  const client = await installationClient(config);
  try {
    const existing = await client.repos.get({ owner: input.owner, repo: input.name });
    if (!existing.data.private) throw new IntegrationError("provider_error", "The target GitHub repository exists but is not private.", false, 409);
    const externalId = String(existing.data.id);
    const bound = input.expectedExternalRepositoryId !== null && externalId === input.expectedExternalRepositoryId;
    const markedRetry = input.expectedExternalRepositoryId === null && existing.data.description === input.ownershipMarker;
    if (!bound && !markedRetry) {
      throw new IntegrationError(
        "provider_error",
        "The target GitHub repository name belongs to an unrelated resource.",
        false,
        409,
      );
    }
    return { id: String(existing.data.id), fullName: existing.data.full_name, htmlUrl: existing.data.html_url, created: false as const };
  } catch (error) {
    if (error instanceof IntegrationError) throw error;
    const status = error && typeof error === "object" && "status" in error ? (error as { status?: number }).status : undefined;
    if (status !== 404) {
      throw new IntegrationError("provider_error", "GitHub could not reconcile the approved repository target.", true);
    }
    if (input.expectedExternalRepositoryId !== null) {
      throw new IntegrationError("provider_error", "The bound GitHub repository is unavailable at its approved name.", false, 409);
    }
  }
  const created = await client.repos.createInOrg({
    org: input.owner,
    name: input.name,
    description: input.ownershipMarker,
    private: true,
    auto_init: false,
    has_issues: true,
  });
  return { id: String(created.data.id), fullName: created.data.full_name, htmlUrl: created.data.html_url, created: true as const };
}

export async function publishVerifiedTree(
  config: GitHubAppConfig,
  input: {
    owner: string;
    repo: string;
    branch: string;
    files: Array<{ path: string; content: Uint8Array }>;
    message: string;
  },
) {
  const client = await installationClient(config);
  const treeItems = await Promise.all(
    input.files.map(async (file) => {
      if (!file.path || file.path.startsWith("/") || file.path.split("/").includes("..")) throw new Error("Invalid repository path.");
      const blob = await client.git.createBlob({
        owner: input.owner,
        repo: input.repo,
        content: Buffer.from(file.content).toString("base64"),
        encoding: "base64",
      });
      return { path: file.path, mode: "100644" as const, type: "blob" as const, sha: blob.data.sha };
    }),
  );
  const tree = await client.git.createTree({ owner: input.owner, repo: input.repo, tree: treeItems });
  let parentSha: string | undefined;
  try {
    const ref = await client.git.getRef({ owner: input.owner, repo: input.repo, ref: `heads/${input.branch}` });
    parentSha = ref.data.object.sha;
    const parent = await client.git.getCommit({ owner: input.owner, repo: input.repo, commit_sha: parentSha });
    if (parent.data.tree.sha === tree.data.sha) return { commitSha: parentSha, treeSha: tree.data.sha, changed: false as const };
  } catch (error) {
    if (!(error instanceof Error && "status" in error && (error as { status?: number }).status === 409)) {
      if (!(error instanceof Error && "status" in error && (error as { status?: number }).status === 404)) throw error;
    }
  }
  const commit = await client.git.createCommit({
    owner: input.owner,
    repo: input.repo,
    message: input.message,
    tree: tree.data.sha,
    parents: parentSha ? [parentSha] : [],
  });
  if (parentSha) {
    await client.git.updateRef({ owner: input.owner, repo: input.repo, ref: `heads/${input.branch}`, sha: commit.data.sha, force: false });
  } else {
    await client.git.createRef({ owner: input.owner, repo: input.repo, ref: `refs/heads/${input.branch}`, sha: commit.data.sha });
  }
  return { commitSha: commit.data.sha, treeSha: tree.data.sha, changed: true as const };
}
