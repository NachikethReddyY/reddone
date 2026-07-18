"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";

import { Icon } from "@/components/icons";
import { Button, EmptyState, Skeleton, StatusBadge } from "@/components/ui";

type SecretGrantMetadata = {
  id: string;
  approvalId: string;
  deploymentId: string | null;
  status: "pending" | "active" | "revoked" | "superseded";
  grantedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
};

type ProjectSecretMetadata = {
  id: string;
  name: string;
  version: number;
  isLatest: boolean;
  status: "active" | "revoked";
  revokedAt: string | null;
  createdAt: string;
  grants: SecretGrantMetadata[];
};

type GrantTarget = {
  artifactId: string;
  artifactHash: string;
  verificationReportId: string;
  verificationReportHash: string;
  verifiedAt: string | null;
  expiresAt: string | null;
};

type SecretIndex = {
  mode: "live" | "demo";
  projectOptimisticVersion: number;
  items: ProjectSecretMetadata[];
  grantTarget: GrantTarget | null;
  message?: string;
};

type ApiEnvelope<T> = { data?: T; error?: { message?: string } };

function shortHash(hash: string) {
  return `${hash.slice(0, 10)}…${hash.slice(-6)}`;
}

async function readResponse<T>(response: Response, fallback: string): Promise<T> {
  const body = await response.json().catch(() => null) as ApiEnvelope<T> | null;
  if (!response.ok || !body?.data) throw new Error(body?.error?.message ?? fallback);
  return body.data;
}

export function ProjectSecretsSettings({ projectId }: { projectId: string }) {
  const [index, setIndex] = useState<SecretIndex | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  const [name, setName] = useState("");
  const [purpose, setPurpose] = useState("");
  const [value, setValue] = useState("");
  const [showValue, setShowValue] = useState(false);
  const [saving, setSaving] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [grantReviewOpen, setGrantReviewOpen] = useState(false);
  const [granting, setGranting] = useState(false);
  const [revoking, setRevoking] = useState("");
  const secretMutationKey = useRef<string | null>(null);
  const grantMutation = useRef<{ fingerprint: string; idempotencyKey: string; expiresAt: string } | null>(null);

  const loadSecrets = useCallback(async (signal?: AbortSignal) => {
    try {
      const response = await fetch(`/api/v1/projects/${projectId}/secrets`, {
        headers: { accept: "application/json" },
        credentials: "same-origin",
        ...(signal ? { signal } : {}),
      });
      const data = await readResponse<SecretIndex>(response, "Project secret metadata is unavailable.");
      setIndex(data);
      setSelectedIds((current) => current.filter((id) => data.items.some((secret) => secret.id === id && secret.status === "active")));
      setError("");
    } catch (loadError) {
      if (loadError instanceof DOMException && loadError.name === "AbortError") return;
      setError(loadError instanceof Error ? loadError.message : "Project secret metadata is unavailable.");
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/v1/projects/${projectId}/secrets`, {
      headers: { accept: "application/json" },
      credentials: "same-origin",
      signal: controller.signal,
    })
      .then((response) => readResponse<SecretIndex>(response, "Project secret metadata is unavailable."))
      .then((data) => {
        setIndex(data);
        setSelectedIds((current) => current.filter((id) => data.items.some((secret) => secret.id === id && secret.status === "active")));
        setError("");
      })
      .catch((loadError: unknown) => {
        if (loadError instanceof DOMException && loadError.name === "AbortError") return;
        setError(loadError instanceof Error ? loadError.message : "Project secret metadata is unavailable.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [projectId]);

  const selectedSecrets = useMemo(
    () => (index?.items ?? []).filter((secret) => selectedIds.includes(secret.id)),
    [index, selectedIds],
  );

  function toggleSecret(secret: ProjectSecretMetadata) {
    grantMutation.current = null;
    setSelectedIds((current) => {
      if (current.includes(secret.id)) return current.filter((id) => id !== secret.id);
      const otherVersions = new Set((index?.items ?? []).filter((item) => item.name === secret.name).map((item) => item.id));
      return [...current.filter((id) => !otherVersions.has(id)), secret.id];
    });
  }

  async function saveSecret(event: FormEvent) {
    event.preventDefault();
    if (!/^[A-Z][A-Z0-9_]{1,99}$/.test(name)) {
      setError("Use an uppercase environment name such as STRIPE_SECRET_KEY.");
      return;
    }
    if (purpose.trim().length < 2 || value.length < 8) {
      setError("Add a short purpose and a secret value of at least eight characters.");
      return;
    }
    setSaving(true);
    setError("");
    const idempotencyKey = secretMutationKey.current ?? `project-secret-${crypto.randomUUID()}`;
    secretMutationKey.current = idempotencyKey;
    try {
      const response = await fetch(`/api/v1/projects/${projectId}/secrets`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": idempotencyKey,
          "if-match": String(index?.projectOptimisticVersion ?? 0),
        },
        credentials: "same-origin",
        body: JSON.stringify({ name, purpose: purpose.trim(), value }),
      });
      const saved = await readResponse<{ mode: "live" | "demo"; name: string; version: number; message?: string }>(response, "The project secret could not be saved.");
      setValue("");
      setShowValue(false);
      setAddOpen(false);
      setName("");
      setPurpose("");
      secretMutationKey.current = null;
      setNotice(saved.mode === "live" ? `${saved.name} v${saved.version} was encrypted and stored. Its value cannot be read back.` : saved.message ?? "Demo mode discarded the supplied value immediately.");
      if (saved.mode === "live") await loadSecrets();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "The project secret could not be saved.");
    } finally {
      setSaving(false);
    }
  }

  async function requestGrant() {
    if (!index?.grantTarget || selectedIds.length === 0) return;
    setGranting(true);
    setError("");
    const fingerprint = `${index.grantTarget.artifactId}:${[...selectedIds].sort().join(",")}`;
    const request = grantMutation.current?.fingerprint === fingerprint
      ? grantMutation.current
      : {
          fingerprint,
          idempotencyKey: `secret-grant-${crypto.randomUUID()}`,
          expiresAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
        };
    grantMutation.current = request;
    try {
      const response = await fetch(`/api/v1/projects/${projectId}/secrets/grants`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": request.idempotencyKey,
          "if-match": String(index.projectOptimisticVersion),
        },
        credentials: "same-origin",
        body: JSON.stringify({
          artifactId: index.grantTarget.artifactId,
          secretVersionIds: selectedIds,
          costCeilingMicros: 0,
          expiresAt: request.expiresAt,
        }),
      });
      const result = await readResponse<{ approval: { id: string }; replayed: boolean }>(response, "The secret grant proposal could not be created.");
      setNotice(`${result.replayed ? "Existing" : "New"} exact-version grant approval ${result.approval.id} is ready for review.`);
      setSelectedIds([]);
      setGrantReviewOpen(false);
      grantMutation.current = null;
      await loadSecrets();
    } catch (grantError) {
      setError(grantError instanceof Error ? grantError.message : "The secret grant proposal could not be created.");
    } finally {
      setGranting(false);
    }
  }

  async function revokeSecret(secret: ProjectSecretMetadata) {
    if (!index || !window.confirm(`Revoke ${secret.name} v${secret.version}? Pending grants will be superseded and new releases cannot use it.`)) return;
    setRevoking(secret.id);
    setError("");
    try {
      const response = await fetch(`/api/v1/projects/${projectId}/secrets/${secret.id}`, {
        method: "DELETE",
        headers: { "idempotency-key": `revoke-secret-${crypto.randomUUID()}`, "if-match": String(index.projectOptimisticVersion) },
        credentials: "same-origin",
      });
      await readResponse(response, "The secret version could not be revoked.");
      setNotice(`${secret.name} v${secret.version} was revoked. Existing provider-side values must be rotated according to their deployment policy.`);
      await loadSecrets();
    } catch (revokeError) {
      setError(revokeError instanceof Error ? revokeError.message : "The secret version could not be revoked.");
    } finally {
      setRevoking("");
    }
  }

  const canProposeGrant = index?.mode === "live" && Boolean(index.grantTarget) && selectedIds.length > 0;

  return (
    <section className="project-secrets-panel" aria-labelledby="runtime-secrets-title">
      <div className="settings-heading">
        <div>
          <span className="eyebrow">Runtime boundary</span>
          <h2 id="runtime-secrets-title">Project secrets</h2>
          <p>Create write-only, versioned runtime values. Selecting a version only prepares an approval; it never grants the value directly.</p>
        </div>
        <div className="secret-heading-actions">
          <Button icon="key" disabled={!index || loading} onClick={() => setAddOpen((open) => !open)}>{addOpen ? "Close form" : "Add secret"}</Button>
          <Button kind="primary" icon="approval" disabled={!canProposeGrant} onClick={() => setGrantReviewOpen(true)}>Request grant</Button>
        </div>
      </div>

      {index?.mode === "demo" && <div className="secret-mode-note"><Icon name="shield" size={19} /><span><strong>Demo vault is intentionally non-persistent.</strong><small>Submitted values are discarded immediately. Deploy with <code>APP_MODE=private</code> or <code>APP_MODE=hackathon</code> to store encrypted versions and request grants.</small></span></div>}
      {notice && <div className="inline-notice notice-success" role="status"><Icon name="check" size={17} /><span>{notice}</span>{notice.includes("approval") && <Link href="/approvals">Open approvals <Icon name="arrow-right" size={15} /></Link>}<button aria-label="Dismiss secret notice" onClick={() => setNotice("")}><Icon name="close" size={16} /></button></div>}
      {error && <div className="inline-error secret-error" role="alert"><Icon name="warning" size={17} /><span>{error}</span><button aria-label="Dismiss secret error" onClick={() => setError("")}><Icon name="close" size={16} /></button></div>}

      {addOpen && (
        <form className="secret-create-panel" onSubmit={saveSecret}>
          <div className="secret-write-only"><Icon name="lock" size={19} /><p><strong>This value is write-only.</strong> After saving, only its name, exact version, state, and timestamps return to the browser.</p></div>
          <div className="field-grid two-col">
            <label className="form-field"><span>Environment name</span><input autoFocus autoCapitalize="characters" autoComplete="off" placeholder="STRIPE_SECRET_KEY" value={name} onChange={(event) => { secretMutationKey.current = null; setName(event.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, "")); }} /><small>Uppercase letters, numbers, and underscores.</small></label>
            <label className="form-field"><span>Purpose</span><input autoComplete="off" placeholder="Create restricted payment sessions" value={purpose} onChange={(event) => { secretMutationKey.current = null; setPurpose(event.target.value); }} /><small>Redacted audit context only; never passed as a secret value.</small></label>
          </div>
          <label className="form-field"><span>Secret value</span><span className="password-field"><input autoComplete="new-password" placeholder="Paste the restricted project credential" type={showValue ? "text" : "password"} value={value} onChange={(event) => { secretMutationKey.current = null; setValue(event.target.value); }} /><button aria-label={showValue ? "Hide secret value" : "Show secret value"} type="button" onClick={() => setShowValue((shown) => !shown)}><Icon name="eye" size={18} /></button></span><small>Use a project-specific, restricted credential. Control-plane provider keys are never grantable.</small></label>
          <footer><Button disabled={saving} type="button" onClick={() => { secretMutationKey.current = null; setAddOpen(false); setValue(""); setShowValue(false); }}>Cancel</Button><Button kind="primary" icon="shield" disabled={saving} type="submit">{saving ? "Encrypting…" : "Encrypt new version"}</Button></footer>
        </form>
      )}

      <div className="secret-target-strip">
        <span className="secret-target-icon"><Icon name="layers" size={20} /></span>
        <div>{index?.grantTarget ? <><small>Latest grantable artifact</small><strong>{shortHash(index.grantTarget.artifactHash)}</strong><span>Verification {shortHash(index.grantTarget.verificationReportHash)}</span></> : <><small>Grant target</small><strong>No current verified artifact</strong><span>Build and verify an artifact before requesting runtime access.</span></>}</div>
        {index?.grantTarget ? <StatusBadge tone="success">Verification passed</StatusBadge> : <StatusBadge tone="neutral">Unavailable</StatusBadge>}
      </div>

      {loading ? (
        <div className="secret-skeleton" aria-label="Loading project secret metadata"><Skeleton /><Skeleton /><Skeleton /></div>
      ) : index?.items.length ? (
        <div className="secret-version-list" role="table" aria-label="Project secret versions">
          <div className="secret-list-head" role="row"><span role="columnheader">Grant</span><span role="columnheader">Name and version</span><span role="columnheader">State</span><span role="columnheader">Created</span><span role="columnheader">Grant state</span></div>
          {index.items.map((secret) => {
            const latestGrant = secret.grants[0];
            const selectable = index.mode === "live" && secret.status === "active";
            return <div className={`secret-version-row ${selectedIds.includes(secret.id) ? "is-selected" : ""}`} role="row" key={secret.id}>
              <span role="cell"><label className="secret-check"><input aria-label={`Select ${secret.name} version ${secret.version} for a grant proposal`} checked={selectedIds.includes(secret.id)} disabled={!selectable} type="checkbox" onChange={() => toggleSecret(secret)} /><i><Icon name="check" size={13} /></i></label></span>
              <span className="secret-name-cell" role="cell"><strong>{secret.name}</strong><small>Version {secret.version}{secret.isLatest ? " · latest" : ""}</small></span>
              <span role="cell"><StatusBadge tone={secret.status === "active" ? "success" : "neutral"}>{secret.status}</StatusBadge></span>
              <time role="cell" dateTime={secret.createdAt}>{new Date(secret.createdAt).toLocaleString()}</time>
              <span role="cell">{secret.status === "revoked" ? <StatusBadge tone="danger">Revoked</StatusBadge> : <>{latestGrant ? <StatusBadge tone={latestGrant.status === "active" ? "success" : latestGrant.status === "pending" ? "warning" : "neutral"}>{latestGrant.status === "active" ? "Granted" : latestGrant.status === "pending" ? "Approval pending" : latestGrant.status}</StatusBadge> : <StatusBadge tone="neutral">Not granted</StatusBadge>}<button className="text-button" disabled={revoking === secret.id} onClick={() => revokeSecret(secret)} type="button">{revoking === secret.id ? "Revoking…" : "Revoke"}</button></>}</span>
            </div>;
          })}
        </div>
      ) : (
        <EmptyState icon="key" title="No stored project secrets" description={index?.mode === "demo" ? "Demo mode discards submitted values immediately. A live vault will list metadata here without returning plaintext." : "Add a restricted project credential to create its first encrypted version."} action={<Button icon="plus" onClick={() => setAddOpen(true)}>Add project secret</Button>} />
      )}

      <div className="secret-selection-note"><Icon name="shield" size={18} /><span><strong>{selectedIds.length ? `${selectedIds.length} exact version${selectedIds.length === 1 ? "" : "s"} selected` : "No versions selected"}</strong><small>Only one version per environment name can enter a proposal. Existing deployments keep their approved versions until a later release changes them.</small></span></div>

      {grantReviewOpen && index?.grantTarget && (
        <div className="secret-grant-review">
          <div><span className="eyebrow">Structured approval proposal</span><h3>Request access to exact secret versions?</h3><p>This creates a pending approval bound to the verified artifact and versions below. It does not expose or deploy any value now.</p></div>
          <div className="secret-grant-bindings">
            {selectedSecrets.map((secret) => <span key={secret.id}><Icon name="key" size={15} /><strong>{secret.name}</strong><code>Version {secret.version}</code></span>)}
            <span><Icon name="layers" size={15} /><strong>Verified artifact</strong><code>{shortHash(index.grantTarget.artifactHash)}</code></span>
            <span><Icon name="clock" size={15} /><strong>Approval expiry</strong><code>24 hours</code></span>
          </div>
          <div className="secret-risk-note"><Icon name="warning" size={18} /><p>Generated runtime code can read granted values. Only approve restricted, project-specific credentials whose provider permissions and spending limits you understand.</p></div>
          <footer><Button disabled={granting} onClick={() => setGrantReviewOpen(false)}>Cancel</Button><Button kind="primary" icon="approval" disabled={granting} onClick={requestGrant}>{granting ? "Creating proposal…" : "Create grant approval"}</Button></footer>
        </div>
      )}
    </section>
  );
}
