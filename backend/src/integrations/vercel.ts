import "server-only";

import { z } from "zod";

import { assertCollisionResistantResourceName } from "@/policy/resource-ownership";
import { getVercelIntegrationSlug } from "@/server/env";
import { IntegrationError } from "./errors";

const vercelTeamIdSchema = z.string().regex(/^team_[A-Za-z0-9_-]+$/);
const teamSchema = z.object({
  id: vercelTeamIdSchema,
  slug: z.string().min(1),
  name: z.string().nullable().optional(),
});

export function requireVercelTeamInstallation(input: {
  teamId: string | null | undefined;
  allowedTeamId?: string | null | undefined;
}) {
  const teamId = vercelTeamIdSchema.safeParse(input.teamId);
  if (!teamId.success) {
    throw new IntegrationError("not_authorized", "The Vercel integration must be installed on a team.", false, 403);
  }
  if (input.allowedTeamId) {
    const allowedTeamId = vercelTeamIdSchema.safeParse(input.allowedTeamId);
    if (!allowedTeamId.success) {
      throw new IntegrationError("not_configured", "The configured Vercel team ID is invalid.", false, 500);
    }
    if (teamId.data !== allowedTeamId.data) {
      throw new IntegrationError(
        "not_authorized",
        "The Vercel integration was authorized for a different team than the configured workspace team.",
        false,
        403,
      );
    }
  }
  return teamId.data;
}

export const REDDONE_VERCEL_RUN_META_KEY = "reddoneRunId";
export const REDDONE_VERCEL_ARTIFACT_META_KEY = "reddoneArtifactHash";
export const REDDONE_VERCEL_OWNERSHIP_ENV_KEY = "REDDONE_RESOURCE_OWNER";

const deploymentMetadataSchema = z.object({
  runId: z.string().uuid(),
  artifactHash: z.string().regex(/^[a-f0-9]{64}$/),
});

export type VercelDeploymentMetadata = z.infer<typeof deploymentMetadataSchema>;

export function createVercelDeploymentMetadata(input: VercelDeploymentMetadata) {
  return deploymentMetadataSchema.parse(input);
}

const listedDeploymentSchema = z
  .object({
    uid: z.string().min(1).optional(),
    id: z.string().min(1).optional(),
    url: z.string().min(1),
    projectId: z.string().optional(),
    state: z.string().optional(),
    readyState: z.string().optional(),
    meta: z.record(z.string(), z.unknown()).optional().default({}),
  })
  .passthrough()
  .refine((deployment) => Boolean(deployment.uid ?? deployment.id), "Vercel deployment is missing its id.");

const deploymentPageSchema = z
  .object({
    deployments: z.array(listedDeploymentSchema).max(100),
    pagination: z
      .object({
        next: z.union([z.string(), z.number(), z.null()]).optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export interface ReconciledVercelDeployment {
  id: string;
  url: string;
  state?: string;
}

function normalizeDeploymentUrl(url: string) {
  const parsed = new URL(url.startsWith("https://") ? url : `https://${url}`);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port || !parsed.hostname.endsWith(".vercel.app")) {
    throw new IntegrationError("invalid_response", "Vercel returned an invalid deployment URL.");
  }
  return parsed.origin;
}

/** Pure parser used by reconciliation and contract tests. Extra provider metadata is ignored. */
export function parseVercelDeploymentPage(
  body: unknown,
  input: { projectId: string; metadata: VercelDeploymentMetadata },
) {
  const expected = deploymentMetadataSchema.parse(input.metadata);
  const page = deploymentPageSchema.parse(body);
  const deployment = page.deployments.find((candidate) => {
    if (candidate.projectId && candidate.projectId !== input.projectId) return false;
    return (
      candidate.meta[REDDONE_VERCEL_RUN_META_KEY] === expected.runId &&
      candidate.meta[REDDONE_VERCEL_ARTIFACT_META_KEY] === expected.artifactHash
    );
  });
  return {
    deployment: deployment
      ? {
          id: deployment.uid ?? deployment.id!,
          url: normalizeDeploymentUrl(deployment.url),
          state: deployment.readyState ?? deployment.state,
        }
      : null,
    next: page.pagination?.next ?? null,
    count: page.deployments.length,
    hasPagination: Boolean(page.pagination),
  };
}

/**
 * Reconciles a possibly completed direct prebuilt deployment before another upload is attempted.
 * The API is intentionally filtered by project and the two stable, non-secret metadata
 * values are matched locally because provider-side metadata filtering is not required.
 */
export async function reconcileRecentVercelDeployment(input: {
  accessToken: string;
  teamId: string;
  projectId: string;
  metadata: VercelDeploymentMetadata;
  since: Date;
}) {
  const metadata = deploymentMetadataSchema.parse(input.metadata);
  const since = Math.max(0, input.since.getTime() - 60_000);
  let until: string | undefined;
  const seenCursors = new Set<string>();

  // A pathological project history fails closed instead of risking a duplicate deployment.
  for (let pageNumber = 0; pageNumber < 20; pageNumber += 1) {
    const url = new URL("https://api.vercel.com/v7/deployments");
    url.searchParams.set("teamId", input.teamId);
    url.searchParams.set("projectId", input.projectId);
    url.searchParams.set("since", String(since));
    url.searchParams.set("limit", "100");
    if (until) url.searchParams.set("until", until);

    const response = await fetch(url, {
      headers: { authorization: `Bearer ${input.accessToken}` },
      cache: "no-store",
    });
    if (!response.ok) {
      throw new IntegrationError(
        "provider_error",
        "Vercel could not reconcile recent project deployments.",
        response.status === 429 || response.status >= 500,
      );
    }
    const page = parseVercelDeploymentPage(await response.json(), { projectId: input.projectId, metadata });
    if (page.deployment) return page.deployment;
    if (page.next === null) {
      if (page.count === 100 && !page.hasPagination) {
        throw new IntegrationError("invalid_response", "Vercel omitted pagination from a full deployment page.", true);
      }
      return null;
    }

    const cursor = String(page.next);
    if (seenCursors.has(cursor)) {
      throw new IntegrationError("invalid_response", "Vercel returned a repeated deployment cursor.", true);
    }
    seenCursors.add(cursor);
    until = cursor;
  }

  throw new IntegrationError("provider_error", "Vercel deployment reconciliation exceeded its safe page limit.", true);
}

export async function testVercelConnection(accessToken: string, expectedTeamId: string) {
  const teamId = requireVercelTeamInstallation({ teamId: expectedTeamId });
  const url = new URL(`https://api.vercel.com/v2/teams/${encodeURIComponent(teamId)}`);
  url.searchParams.set("teamId", teamId);
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${accessToken}` },
    cache: "no-store",
  });
  if (!response.ok) {
    const denied = response.status === 401 || response.status === 403 || response.status === 404;
    throw new IntegrationError(
      denied ? "not_authorized" : "provider_error",
      denied
        ? "The Vercel credential cannot access the installed team."
        : "Vercel could not verify the installed team.",
      response.status === 429 || response.status >= 500,
      denied ? 403 : response.status === 429 ? 429 : 502,
    );
  }
  const team = teamSchema.parse(await response.json());
  if (team.id !== teamId) {
    throw new IntegrationError("invalid_response", "Vercel returned a different team than the installed team.", false, 403);
  }
  return { ok: true as const, accountId: teamId, account: team.name?.trim() || team.slug };
}

export function createVercelAuthorizationUrl(input: {
  state: string;
  environment?: Readonly<Record<string, string | undefined>>;
}) {
  const slug = getVercelIntegrationSlug(input.environment);
  if (!slug) throw new IntegrationError("not_configured", "Vercel integration installation is not configured.", false, 400);
  const url = new URL(`https://vercel.com/integrations/${slug}/new`);
  url.searchParams.set("state", input.state);
  return url.toString();
}

/** Validates Vercel's external-installation completion URL to avoid an open redirect. */
export function parseVercelInstallationCompletionUrl(value: string | null): URL | null {
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new IntegrationError("not_authorized", "Vercel returned an invalid installation completion URL.", false, 400);
  }
  if (url.protocol !== "https:" || url.hostname !== "vercel.com") {
    throw new IntegrationError("not_authorized", "Vercel returned an untrusted installation completion URL.", false, 400);
  }
  return url;
}

export async function reconcileVercelProject(input: {
  accessToken: string;
  teamId: string;
  name: string;
  ownershipMarker: string;
  expectedExternalProjectId: string | null;
}) {
  if (input.expectedExternalProjectId === null) {
    assertCollisionResistantResourceName(input.name, input.ownershipMarker);
  }
  const lookup = input.expectedExternalProjectId ?? input.name;
  const base = `https://api.vercel.com/v10/projects/${encodeURIComponent(lookup)}?teamId=${encodeURIComponent(input.teamId)}`;
  const existing = await fetch(base, { headers: { authorization: `Bearer ${input.accessToken}` }, cache: "no-store" });
  if (existing.ok) {
    const project = z.object({ id: z.string(), name: z.string() }).passthrough().parse(await existing.json());
    if (input.expectedExternalProjectId !== null) {
      if (project.id !== input.expectedExternalProjectId) {
        throw new IntegrationError("provider_error", "Vercel returned a different project than the canonical binding.", false, 409);
      }
    } else {
      if (project.name !== input.name) {
        throw new IntegrationError("provider_error", "Vercel returned a different project name than the approved target.", false, 409);
      }
      const markerResponse = await fetch(
        `https://api.vercel.com/v10/projects/${encodeURIComponent(project.id)}/env?teamId=${encodeURIComponent(input.teamId)}`,
        { headers: { authorization: `Bearer ${input.accessToken}` }, cache: "no-store" },
      );
      if (!markerResponse.ok) {
        throw new IntegrationError(
          "provider_error",
          "Vercel could not verify ownership of the existing project.",
          markerResponse.status === 429 || markerResponse.status >= 500,
        );
      }
      const markerInventory = z
        .object({
          envs: z.array(
            z.object({
              key: z.string(),
              value: z.string().optional(),
              type: z.string(),
              target: z.union([z.string(), z.array(z.string())]).optional(),
            }).passthrough(),
          ).max(2_000),
        })
        .passthrough()
        .safeParse(await markerResponse.json());
      if (!markerInventory.success) {
        throw new IntegrationError("invalid_response", "Vercel returned an invalid project ownership inventory.", true);
      }
      const markers = markerInventory.data.envs.filter((variable) => variable.key === REDDONE_VERCEL_OWNERSHIP_ENV_KEY);
      const marker = markers[0];
      const targets = marker?.target === undefined ? [] : Array.isArray(marker.target) ? marker.target : [marker.target];
      if (
        markers.length !== 1 ||
        marker?.type !== "plain" ||
        marker.value !== input.ownershipMarker ||
        targets.length !== 2 ||
        !targets.includes("production") ||
        !targets.includes("preview")
      ) {
        throw new IntegrationError("provider_error", "The target Vercel project name belongs to an unrelated resource.", false, 409);
      }
    }
    return { ...project, created: false as const };
  }
  if (existing.status !== 404) throw new IntegrationError("provider_error", "Vercel could not reconcile the target project.", existing.status >= 500);
  if (input.expectedExternalProjectId !== null) {
    throw new IntegrationError("provider_error", "The bound Vercel project is unavailable.", false, 409);
  }
  const created = await fetch(`https://api.vercel.com/v11/projects?teamId=${encodeURIComponent(input.teamId)}`, {
    method: "POST",
    headers: { authorization: `Bearer ${input.accessToken}`, "content-type": "application/json" },
    body: JSON.stringify({
      name: input.name,
      framework: null,
      environmentVariables: [
        {
          key: REDDONE_VERCEL_OWNERSHIP_ENV_KEY,
          value: input.ownershipMarker,
          type: "plain",
          target: ["production", "preview"],
        },
      ],
    }),
    cache: "no-store",
  });
  if (!created.ok) throw new IntegrationError("provider_error", "Vercel could not create the deployment project.", created.status >= 500);
  const project = z.object({ id: z.string(), name: z.string() }).passthrough().parse(await created.json());
  return { ...project, created: true as const };
}

export async function getVercelDeployment(input: { accessToken: string; teamId: string; url: string }) {
  const hostname = new URL(input.url).hostname;
  const response = await fetch(
    `https://api.vercel.com/v13/deployments/${encodeURIComponent(hostname)}?teamId=${encodeURIComponent(input.teamId)}`,
    { headers: { authorization: `Bearer ${input.accessToken}` }, cache: "no-store" },
  );
  if (!response.ok) throw new IntegrationError("provider_error", "Vercel did not return the candidate deployment.", response.status >= 500);
  return z
    .object({ id: z.string(), url: z.string(), readyState: z.string().optional(), projectId: z.string().optional() })
    .passthrough()
    .parse(await response.json());
}
