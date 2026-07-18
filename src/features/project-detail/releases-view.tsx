"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { Icon } from "@/components/icons";
import { Button, ButtonLink, Dialog, EmptyState, StatusBadge, Surface } from "@/components/ui";
import type { HealthTone } from "@/demo-data/control-plane";

type RepositorySnapshot = {
  owner?: string;
  name?: string;
  fullName?: string;
  url?: string;
  visibility?: string;
  defaultBranch?: string;
  status?: string;
  installationId?: string;
  lastCommitSha?: string | null;
};

type DeploymentSnapshot = {
  id: string;
  previousDeploymentId?: string | null;
  externalProjectId?: string;
  externalDeploymentId?: string;
  teamId?: string;
  environment?: string;
  status?: string;
  health?: string;
  optimisticVersion?: number;
  artifactHash?: string | null;
  url?: string | null;
  healthCheckUrl?: string | null;
  healthFailure?: string | null;
  lastKnownGood?: boolean;
  promotedAt?: string | null;
  rolledBackAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
};

type ProjectSnapshot = {
  id: string;
  name?: string;
  slug?: string;
  status?: string;
  optimisticVersion?: number;
  version?: number;
  repository?: RepositorySnapshot | null;
  deployments?: DeploymentSnapshot[];
  deployment?: {
    id?: string;
    externalProjectId?: string;
    externalDeploymentId?: string;
    teamId?: string;
    artifactHash?: string;
    url: string;
    healthCheckUrl?: string;
    health: string;
    lastKnownGoodUrl: string;
    createdAt?: string;
    promotedAt?: string;
  } | null;
};

type ApprovalSnapshot = {
  id: string;
  kind: string;
  status: string;
  payload?: Record<string, unknown>;
};

type ReleaseState = {
  project: ProjectSnapshot;
  approvals: ApprovalSnapshot[];
};

type UiDeployment = {
  id: string;
  previousDeploymentId: string | null;
  externalProjectId: string | null;
  externalDeploymentId: string | null;
  teamId: string | null;
  environment: string;
  status: string;
  optimisticVersion: number;
  artifactHash: string | null;
  url: string | null;
  healthCheckUrl: string | null;
  healthFailure: string | null;
  lastKnownGood: boolean;
  promotedAt: string | null;
  rolledBackAt: string | null;
  createdAt: string | null;
  isDemo: boolean;
};

async function responseData<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => null) as { data?: T; error?: { message?: string } } | null;
  if (!response.ok || !body || !("data" in body)) {
    throw new Error(body?.error?.message ?? `Request failed (${response.status}).`);
  }
  return body.data as T;
}

async function fetchReleaseState(projectId: string): Promise<ReleaseState> {
  const [projectResponse, approvalsResponse] = await Promise.all([
    fetch(`/api/v1/projects/${projectId}`, { headers: { accept: "application/json" }, cache: "no-store" }),
    fetch(`/api/v1/approvals?projectId=${encodeURIComponent(projectId)}`, { headers: { accept: "application/json" }, cache: "no-store" }),
  ]);
  const [project, approvals] = await Promise.all([
    responseData<ProjectSnapshot>(projectResponse),
    responseData<{ items: ApprovalSnapshot[] }>(approvalsResponse),
  ]);
  return { project, approvals: approvals.items };
}

function normalizedStatus(value: string | undefined, fallback = "queued") {
  return (value ?? fallback).toLowerCase();
}

function statusLabel(value: string) {
  return value.replaceAll("_", " ").replace(/\b\w/g, (character) => character.toUpperCase());
}

function statusTone(value: string): HealthTone {
  if (value === "healthy" || value === "ready") return "success";
  if (value === "failed" || value === "canceled" || value === "disconnected") return "danger";
  if (["queued", "uploading", "ready_unpromoted", "health_checking", "pending"].includes(value)) return "warning";
  return "neutral";
}

function shortHash(value: string | null | undefined, length = 9) {
  if (!value) return "Not recorded";
  if (value.length <= length * 2) return value;
  return `${value.slice(0, length)}…${value.slice(-6)}`;
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function externalUrl(value: string | null | undefined) {
  if (!value) return null;
  try {
    const url = new URL(value.includes("://") ? value : `https://${value}`);
    return url.protocol === "https:" ? url.toString().replace(/\/$/, "") : null;
  } catch {
    return null;
  }
}

function displayUrl(value: string) {
  try {
    return new URL(value).host;
  } catch {
    return value;
  }
}

function formatDate(value: string | null | undefined) {
  if (!value) return "Not recorded";
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "Not recorded";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function normalizeDeployments(project: ProjectSnapshot): UiDeployment[] {
  if (project.deployments?.length) {
    return project.deployments.map((deployment) => ({
      id: deployment.id,
      previousDeploymentId: deployment.previousDeploymentId ?? null,
      externalProjectId: deployment.externalProjectId ?? null,
      externalDeploymentId: deployment.externalDeploymentId ?? null,
      teamId: deployment.teamId ?? null,
      environment: deployment.environment ?? "production",
      status: normalizedStatus(deployment.status ?? deployment.health),
      optimisticVersion: deployment.optimisticVersion ?? 0,
      artifactHash: deployment.artifactHash ?? null,
      url: externalUrl(deployment.url),
      healthCheckUrl: externalUrl(deployment.healthCheckUrl),
      healthFailure: deployment.healthFailure ?? null,
      lastKnownGood: deployment.lastKnownGood ?? false,
      promotedAt: deployment.promotedAt ?? null,
      rolledBackAt: deployment.rolledBackAt ?? null,
      createdAt: deployment.createdAt ?? null,
      isDemo: false,
    }));
  }
  if (!project.deployment) return [];
  return [{
    id: project.deployment.id ?? `demo-${project.id}-deployment`,
    previousDeploymentId: null,
    externalProjectId: project.deployment.externalProjectId ?? project.slug ?? project.id,
    externalDeploymentId: project.deployment.externalDeploymentId ?? null,
    teamId: project.deployment.teamId ?? "Demo workspace",
    environment: "production",
    status: normalizedStatus(project.deployment.health, "healthy"),
    optimisticVersion: project.version ?? 0,
    artifactHash: project.deployment.artifactHash ?? null,
    url: externalUrl(project.deployment.url),
    healthCheckUrl: externalUrl(project.deployment.healthCheckUrl ?? (project.deployment.url ? `${project.deployment.url.replace(/\/$/, "")}/api/health` : null)),
    healthFailure: null,
    lastKnownGood: true,
    promotedAt: project.deployment.promotedAt ?? null,
    rolledBackAt: null,
    createdAt: project.deployment.createdAt ?? null,
    isDemo: true,
  }];
}

function repositoryDetails(project: ProjectSnapshot) {
  const repository = project.repository;
  if (!repository) return null;
  const fromFullName = repository.fullName?.split("/") ?? [];
  const owner = repository.owner ?? fromFullName[0] ?? "Workspace installation";
  const name = repository.name ?? (fromFullName.slice(1).join("/") || project.slug || project.id);
  const fullName = repository.fullName ?? `${owner}/${name}`;
  return {
    owner,
    name,
    fullName,
    url: externalUrl(repository.url ?? `https://github.com/${owner}/${name}`),
    visibility: repository.visibility ?? "private",
    defaultBranch: repository.defaultBranch ?? "main",
    status: normalizedStatus(repository.status, "ready"),
    installationId: repository.installationId ?? null,
    lastCommitSha: repository.lastCommitSha ?? null,
  };
}

function approvalSummary(approval: ApprovalSnapshot) {
  const payload = approval.payload ?? {};
  const parts: string[] = [];
  if (typeof payload.specHash === "string") parts.push(`spec ${shortHash(payload.specHash)}`);
  if (typeof payload.artifactHash === "string") parts.push(`artifact ${shortHash(payload.artifactHash)}`);
  const repository = payload.repository;
  if (typeof repository === "object" && repository !== null) {
    const record = repository as Record<string, unknown>;
    if (typeof record.owner === "string" && typeof record.name === "string") parts.push(`${record.owner}/${record.name} private repository`);
  }
  const deployment = payload.deployment;
  if (typeof deployment === "object" && deployment !== null) {
    const record = deployment as Record<string, unknown>;
    if (typeof record.teamId === "string") parts.push(`${record.teamId} ${typeof record.environment === "string" ? record.environment : "production"}`);
  }
  if (Array.isArray(payload.secretGrants)) parts.push(`${payload.secretGrants.length} exact secret grant${payload.secretGrants.length === 1 ? "" : "s"}`);
  if (typeof payload.costCeilingMicros === "number") parts.push(`$${(payload.costCeilingMicros / 1_000_000).toFixed(2)} ceiling`);
  return parts.length ? `Approval binds ${parts.join(", ")}.` : "Review the canonical hashes, provider accounts, target, grants, cost ceiling, versions, and expiry before approval.";
}

function ExternalButtonLink({ href, kind = "secondary", children }: { href: string; kind?: "primary" | "secondary"; children: string }) {
  return <a className={`button button-${kind}`} href={href} rel="noreferrer" target="_blank"><Icon name="external" size={18} /><span>{children}</span></a>;
}

export function ReleasesView({ projectId }: { projectId: string }) {
  const [state, setState] = useState<ReleaseState | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState("Production changes only after an exact release or rollback approval is consumed.");
  const [rollbackTarget, setRollbackTarget] = useState<UiDeployment | null>(null);

  const load = useCallback(async () => {
    try {
      setState(await fetchReleaseState(projectId));
      setError(null);
      return true;
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Release state could not be loaded.");
      return false;
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    let active = true;
    void fetchReleaseState(projectId)
      .then((nextState) => {
        if (!active) return;
        setState(nextState);
        setError(null);
      })
      .catch((loadError: unknown) => {
        if (active) setError(loadError instanceof Error ? loadError.message : "Release state could not be loaded.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [projectId]);

  const deployments = useMemo(() => state ? normalizeDeployments(state.project) : [], [state]);
  const repository = useMemo(() => state ? repositoryDetails(state.project) : null, [state]);
  const currentDeployment = useMemo(() => (
    deployments.find((deployment) => deployment.lastKnownGood)
      ?? deployments.find((deployment) => deployment.environment.toLowerCase() === "production" && deployment.status === "healthy")
      ?? null
  ), [deployments]);
  const previousDeployment = useMemo(() => {
    if (!currentDeployment?.previousDeploymentId) return null;
    return deployments.find((deployment) => deployment.id === currentDeployment.previousDeploymentId) ?? null;
  }, [currentDeployment, deployments]);
  const pendingApproval = useMemo(() => state?.approvals.find((approval) => (
    approval.status.toLowerCase() === "pending"
      && ["first_release", "polish_release", "rollback"].includes(approval.kind.toLowerCase())
  )) ?? null, [state]);

  async function refresh() {
    setRefreshing(true);
    setError(null);
    const refreshed = await load();
    setRefreshing(false);
    setNotice(refreshed ? "Canonical repository, deployment, health, and approval state refreshed." : "Release state could not be refreshed. Try again.");
  }

  function retryLoad() {
    setLoading(true);
    setError(null);
    void load();
  }

  async function requestRollback() {
    if (!rollbackTarget || !currentDeployment) return;
    setWorking(true);
    try {
      const result = await responseData<{ id?: string; mode?: string; message?: string }>(await fetch(`/api/v1/deployments/${currentDeployment.id}/rollback`, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "idempotency-key": `rollback-${crypto.randomUUID()}`,
          "if-match": String(currentDeployment.optimisticVersion),
        },
        body: JSON.stringify({ targetDeploymentId: rollbackTarget.id, costCeilingMicros: 500_000 }),
      }));
      setRollbackTarget(null);
      setNotice(result.id
        ? `Rollback approval ${shortHash(result.id, 7)} is pending. Production remains unchanged until its exact payload is approved.`
        : result.message ?? "Rollback simulated; no external deployment changed.");
      await load();
    } catch (requestError) {
      setNotice(requestError instanceof Error ? requestError.message : "Rollback approval could not be created.");
    } finally {
      setWorking(false);
    }
  }

  if (loading) {
    return <div className="content-stack" aria-busy="true" aria-label="Loading release state"><Surface className="release-gate"><div className="release-visual" aria-hidden="true"><span className="release-node"><Icon name="layers" size={23} /></span><i /><span className="release-node"><Icon name="branch" size={23} /></span><i /><span className="release-node"><Icon name="globe" size={23} /></span></div><div><span className="eyebrow">Canonical release state</span><h2>Loading repository and deployments…</h2><p>Reading workspace-owned records without contacting generated applications.</p></div><StatusBadge tone="neutral">Loading</StatusBadge></Surface></div>;
  }

  if (!state || error) {
    return <Surface className="deployments-surface"><EmptyState icon="warning" title="Release state is unavailable" description={error ?? "The project record could not be read."} action={<Button icon="retry" onClick={retryLoad}>Try again</Button>} /></Surface>;
  }

  const gateKind = pendingApproval?.kind.toLowerCase();
  const gateTitle = pendingApproval
    ? gateKind === "rollback" ? "An exact rollback target is waiting for review." : "A verified candidate is waiting at the release gate."
    : currentDeployment ? "Production is on the recorded last-known-good deployment." : "No verified candidate has reached the release gate.";
  const gateCopy = pendingApproval
    ? approvalSummary(pendingApproval)
    : currentDeployment
      ? `Production remains bound to artifact ${shortHash(currentDeployment.artifactHash)}. Any rollback creates a separate canonical approval before provider side effects.`
      : "Complete a clean two-sandbox build first. Repository creation, secret grants, deployment, promotion, and rollback stay disabled until their approval conditions exist.";

  return (
    <div className="content-stack">
      <Surface className="release-gate">
        <div className="release-visual" aria-hidden="true"><span className="release-node"><Icon name="layers" size={23} /></span><i /><span className="release-node"><Icon name="branch" size={23} /></span><i /><span className="release-node"><Icon name="globe" size={23} /></span><b><Icon name="lock" size={16} /></b></div>
        <div><span className="eyebrow">Atomic release gate</span><h2>{gateTitle}</h2><p>{gateCopy}</p></div>
        {pendingApproval
          ? <ButtonLink href="/approvals" kind="primary" icon="approval">Review exact payload</ButtonLink>
          : currentDeployment?.url
            ? <ExternalButtonLink href={currentDeployment.url} kind="primary">Open production</ExternalButtonLink>
            : <ButtonLink href={`/projects/${projectId}/builds`} kind="primary" icon="layers">Go to verified build</ButtonLink>}
      </Surface>

      <div className="inline-notice" aria-live="polite"><Icon name="shield" size={17} /><span>{notice}</span></div>

      <div className="release-grid">
        <Surface className="repository-card">
          <div className="surface-head"><div><span className="eyebrow">Source destination</span><h2>GitHub repository</h2></div><StatusBadge tone={repository ? statusTone(repository.status) : "neutral"}>{repository ? statusLabel(repository.status) : "Not created"}</StatusBadge></div>
          <div className="provider-account"><span><Icon name="branch" size={25} /></span><div><strong>{repository?.fullName ?? "Private repository pending"}</strong><small>{repository?.installationId ? `GitHub App installation ${repository.installationId}` : "Created only after release approval is consumed"}</small></div></div>
          <dl><div><dt>Visibility</dt><dd>{repository?.visibility ? statusLabel(repository.visibility) : "Private only"}</dd></div><div><dt>Repository</dt><dd>{repository?.name ?? state.project.slug ?? "Assigned by approval"}</dd></div><div><dt>Default branch</dt><dd>{repository?.defaultBranch ?? "main"}</dd></div><div><dt>Last commit</dt><dd><code>{shortHash(repository?.lastCommitSha)}</code></dd></div></dl>
          <div className="permission-note"><Icon name="key" size={18} /><p>A short-lived installation token is minted after approval and never enters a sandbox.</p></div>
          {repository?.url && <ExternalButtonLink href={repository.url}>Open private repository</ExternalButtonLink>}
        </Surface>

        <Surface className="repository-card">
          <div className="surface-head"><div><span className="eyebrow">Deployment destination</span><h2>Vercel production</h2></div><StatusBadge tone={currentDeployment ? statusTone(currentDeployment.status) : "neutral"}>{currentDeployment ? statusLabel(currentDeployment.status) : "Not deployed"}</StatusBadge></div>
          <div className="provider-account"><span><Icon name="globe" size={25} /></span><div><strong>{currentDeployment ? `${currentDeployment.teamId ?? "Connected team"} / ${statusLabel(currentDeployment.environment)}` : "Prebuilt deployment pending"}</strong><small>{currentDeployment?.url ? displayUrl(currentDeployment.url) : "Git auto-deploy remains off"}</small></div></div>
          <dl><div><dt>Project</dt><dd>{currentDeployment?.externalProjectId ?? "Assigned by approval"}</dd></div><div><dt>Environment</dt><dd>{currentDeployment ? statusLabel(currentDeployment.environment) : "Production"}</dd></div><div><dt>Artifact</dt><dd><code>{shortHash(currentDeployment?.artifactHash)}</code></dd></div><div><dt>Health path</dt><dd><code>{currentDeployment?.healthCheckUrl ? new URL(currentDeployment.healthCheckUrl).pathname : "/api/health"}</code></dd></div></dl>
          <div className="permission-note"><Icon name="shield" size={18} /><p>Production promotion happens only after the prebuilt candidate passes its health check.</p></div>
        </Surface>
      </div>

      <Surface className="deployments-surface">
        <div className="surface-head"><div><span className="eyebrow">Release history</span><h2>Deployments</h2><p>Production promotion and rollback are separate, approval-gated transitions.</p></div><Button disabled={refreshing} icon="retry" onClick={refresh}>{refreshing ? "Refreshing…" : "Refresh state"}</Button></div>
        {deployments.length === 0 ? <EmptyState icon="globe" title="No deployment history yet" description="An approved, verified prebuilt release will appear here with its health state and rollback pointer." action={<ButtonLink href={`/projects/${projectId}/builds`} icon="layers">Inspect builds</ButtonLink>} /> : <div className="deployment-list">
          {deployments.map((deployment) => {
            const isCurrent = deployment.id === currentDeployment?.id;
            const isPreviousTarget = deployment.id === previousDeployment?.id;
            const canRequestRollback = Boolean(
              isPreviousTarget
              && currentDeployment
              && isUuid(currentDeployment.id)
              && isUuid(deployment.id)
              && deployment.url
              && ["healthy", "rolled_back"].includes(deployment.status),
            );
            const note = isCurrent
              ? "Current production · last-known-good"
              : deployment.healthFailure
                ? deployment.healthFailure
                : deployment.rolledBackAt
                  ? `Rolled back ${formatDate(deployment.rolledBackAt)}`
                  : isPreviousTarget
                    ? "Recorded rollback target · approval required"
                    : deployment.status === "ready_unpromoted"
                      ? "Healthy candidate · not promoted"
                      : "Historical prebuilt deployment";
            return <article className="deployment-row" key={deployment.id}>
              <span className={`deployment-status is-${deployment.status}`}><Icon name={deployment.status === "healthy" ? "check" : deployment.status === "failed" || deployment.status === "canceled" ? "x" : "clock"} size={16} /></span>
              <div className="deployment-main"><span><strong>{statusLabel(deployment.environment)}</strong><StatusBadge tone={statusTone(deployment.status)}>{isCurrent ? `Current · ${statusLabel(deployment.status)}` : statusLabel(deployment.status)}</StatusBadge></span>{deployment.url ? <a href={deployment.url} target="_blank" rel="noreferrer">{displayUrl(deployment.url)}<Icon name="external" size={14} /></a> : <small>Provider URL not available</small>}<small>{note}</small></div>
              <div><small>Artifact</small><code>{shortHash(deployment.artifactHash, 6)}</code></div><div><small>Created</small><strong>{formatDate(deployment.createdAt ?? deployment.promotedAt)}</strong></div>
              {canRequestRollback
                ? <Button icon="retry" onClick={() => setRollbackTarget(deployment)}>Request rollback</Button>
                : deployment.url
                  ? <ExternalButtonLink href={deployment.url}>Inspect</ExternalButtonLink>
                  : <Button disabled icon="eye">Unavailable</Button>}
            </article>;
          })}
        </div>}
        {currentDeployment && !previousDeployment && <div className="permission-note"><Icon name="shield" size={18} /><p>No safe rollback target is recorded yet. ReDDone enables rollback only when the current deployment points to a previous verified release.</p></div>}
      </Surface>

      {rollbackTarget && currentDeployment && (
        <Dialog
          className="confirm-dialog-frame"
          contentClassName="confirm-dialog-surface"
          description={<>This creates a canonical approval targeting deployment <code>{shortHash(rollbackTarget.id, 7)}</code>. Production remains on <strong>{currentDeployment.url ? displayUrl(currentDeployment.url) : "the current deployment"}</strong> until that exact approval is consumed.</>}
          footer={<><Button disabled={working} onClick={() => setRollbackTarget(null)}>Cancel</Button><Button autoFocus disabled={working} icon="approval" onClick={requestRollback}>{working ? "Creating approval…" : "Request approval"}</Button></>}
          onOpenChange={(open) => { if (!open && !working) setRollbackTarget(null); }}
          open
          title="Request rollback approval?"
        >
            <span className="confirm-icon"><Icon name="retry" size={25} /></span>
            <div className="confirm-target"><span>Rollback target</span><strong>{rollbackTarget.url ? displayUrl(rollbackTarget.url) : shortHash(rollbackTarget.id)}</strong><small>Artifact {shortHash(rollbackTarget.artifactHash)} · {formatDate(rollbackTarget.createdAt ?? rollbackTarget.promotedAt)}</small></div>
        </Dialog>
      )}
    </div>
  );
}
