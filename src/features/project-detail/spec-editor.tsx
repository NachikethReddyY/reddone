"use client";

import { useEffect, useState } from "react";
import { Icon } from "@/components/icons";
import { Button, EmptyState, Skeleton, StatusBadge, Surface } from "@/components/ui";
import type { ProductSpec } from "@/contracts";
import { productSpec } from "@/demo-data/control-plane";

const initialSpec: ProductSpec = {
  productName: "LatePay Copilot",
  oneLinePitch: productSpec.oneLiner,
  problem: "Independent service businesses lose attention and cash flow while manually reconstructing overdue invoice context.",
  targetAudience: productSpec.targetUser,
  proposedSolution: "A calm receivables cockpit that prioritizes risk and drafts evidence-backed follow-up while preserving human approval.",
  inScope: productSpec.features,
  outOfScope: productSpec.nonGoals,
  userStories: [{ actor: "Workspace owner", need: "a prioritized invoice queue", outcome: "I can act on cash-flow risk without reconstructing every conversation" }],
  acceptanceCriteria: productSpec.acceptance,
  constraints: ["No external action without human approval", "Responsive and keyboard accessible"],
  risks: ["Generated language may be incorrect and must remain reviewable"],
  evidenceIds: ["fixture-evidence-1"],
};

type StoredSpec = {
  id: string;
  version: number;
  optimisticVersion?: number;
  status?: string;
  content?: ProductSpec;
  contentHash?: string;
  hash?: string;
  title?: string;
  summary?: string;
  audience?: string;
  jobs?: string[];
  features?: Array<{ name: string }>;
  nonGoals?: string[];
  createdAt?: string;
  updatedAt?: string;
  createdByUserId?: string | null;
  model?: string | null;
};

function runtimeSpec(stored: StoredSpec): ProductSpec {
  if (stored.content) return stored.content;
  return {
    ...initialSpec,
    productName: stored.title ?? initialSpec.productName,
    oneLinePitch: stored.summary ?? initialSpec.oneLinePitch,
    targetAudience: stored.audience ?? initialSpec.targetAudience,
    inScope: stored.features?.map((feature) => feature.name) ?? initialSpec.inScope,
    outOfScope: stored.nonGoals ?? initialSpec.outOfScope,
    userStories: stored.jobs?.map((job) => ({ actor: "Workspace owner", need: job, outcome: "the approved workflow is completed safely" })) ?? initialSpec.userStories,
  };
}

export function SpecEditor({ projectId }: { projectId: string }) {
  const [oneLiner, setOneLiner] = useState(productSpec.oneLiner);
  const [targetUser, setTargetUser] = useState(productSpec.targetUser);
  const [features, setFeatures] = useState(productSpec.features);
  const [completeSpec, setCompleteSpec] = useState<ProductSpec>(initialSpec);
  const [specId, setSpecId] = useState(productSpec.id);
  const [version, setVersion] = useState(productSpec.version);
  const [optimisticVersion, setOptimisticVersion] = useState(productSpec.version);
  const [contentHash, setContentHash] = useState(productSpec.hash);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState(productSpec.updatedAt);
  const [conflict, setConflict] = useState(false);
  const [notice, setNotice] = useState("");
  const [history, setHistory] = useState<StoredSpec[]>([]);
  const [status, setStatus] = useState("loading");
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let active = true;
    fetch(`/api/v1/projects/${projectId}`, { headers: { accept: "application/json" } })
      .then(async (response) => {
        const body = await response.json() as { data?: { currentSpecVersionId?: string | null; spec?: StoredSpec | null; specVersions?: StoredSpec[] }; error?: { message?: string } };
        if (!response.ok || !body.data) throw new Error(body.error?.message ?? "Specification unavailable.");
        const stored = body.data.specVersions?.find((item) => item.id === body.data?.currentSpecVersionId)
          ?? body.data.specVersions?.[0]
          ?? body.data.spec;
        if (!stored) throw new Error("Research has not produced a specification yet.");
        return { stored, history: body.data.specVersions ?? [stored] };
      })
      .then(({ stored, history: versions }) => {
        if (!active) return;
        const spec = runtimeSpec(stored);
        setCompleteSpec(spec);
        setOneLiner(spec.oneLinePitch);
        setTargetUser(spec.targetAudience);
        setFeatures(spec.inScope);
        setSpecId(stored.id);
        setVersion(stored.version);
        setOptimisticVersion(stored.optimisticVersion ?? stored.version);
        setContentHash(stored.contentHash ?? stored.hash ?? "hash unavailable");
        setSavedAt("Loaded from canonical state");
        setStatus(stored.status?.toLowerCase() ?? "draft");
        setHistory(versions);
        setLoaded(true);
      })
      .catch((error: unknown) => { if (active) setNotice(error instanceof Error ? error.message : "Specification unavailable."); });
    return () => { active = false; };
  }, [projectId]);

  function updateFeature(index: number, value: string) {
    setFeatures((current) => current.map((feature, featureIndex) => featureIndex === index ? value : feature));
    setDirty(true);
  }

  async function save() {
    if (conflict) return;
    setSaving(true);
    setNotice("");
    const nextSpec: ProductSpec = { ...completeSpec, oneLinePitch: oneLiner.trim(), targetAudience: targetUser.trim(), inScope: features.map((feature) => feature.trim()).filter(Boolean) };
    try {
      const response = await fetch(`/api/v1/specs/${specId}`, {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          "idempotency-key": `spec-${crypto.randomUUID()}`,
          "if-match": String(optimisticVersion),
        },
        body: JSON.stringify({ spec: nextSpec, optimisticVersion }),
      });
      const body = await response.json().catch(() => null) as { data?: { spec?: StoredSpec }; error?: { code?: string; message?: string } } | null;
      if (!response.ok) {
        if (response.status === 409 || response.status === 412 || body?.error?.code?.includes("precondition")) setConflict(true);
        throw new Error(body?.error?.message ?? "The new specification version could not be saved.");
      }
      const stored = body?.data?.spec;
      setCompleteSpec(nextSpec);
      if (stored) {
        setSpecId(stored.id);
        setVersion(stored.version);
        setOptimisticVersion(stored.optimisticVersion ?? stored.version);
        setContentHash(stored.contentHash ?? stored.hash ?? contentHash);
        setStatus(stored.status?.toLowerCase() ?? "pending_approval");
        setHistory((current) => [stored, ...current.map((item) => item.id === specId ? { ...item, status: "superseded" } : item)]);
      } else {
        setVersion((current) => current + 1);
        setOptimisticVersion((current) => current + 1);
      }
      setSaving(false);
      setDirty(false);
      setSavedAt("Just now");
      setNotice("A new immutable specification version was created and sent to a fresh approval gate.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "The specification could not be saved.");
      setSaving(false);
    }
  }

  function exportSpec() {
    const blob = new Blob([JSON.stringify({ id: specId, version, status, contentHash, spec: completeSpec }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${completeSpec.productName.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-spec-v${version}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  const statusLabel = status.replaceAll("_", " ");
  const statusTone = status === "approved" ? "success" : status === "pending_approval" ? "warning" : "neutral";

  if (!loaded) {
    if (notice) return <EmptyState icon="warning" title="Specification unavailable" description={`${notice} No demo specification was substituted.`} action={<Button icon="retry" onClick={() => window.location.reload()}>Retry</Button>} />;
    return <div aria-busy="true" aria-label="Loading specification" className="content-stack" role="status"><Skeleton className="loading-title" /><Skeleton className="loading-panel" /><Skeleton className="loading-panel" /></div>;
  }

  return (
    <div className="spec-layout">
      <aside className="spec-outline">
        <span className="nav-label">Document outline</span>
        <a href="#spec-position">Position</a><a href="#spec-workflow">Core workflow</a><a href="#spec-features">Features</a><a href="#spec-nongoals">Non-goals</a><a href="#spec-acceptance">Acceptance</a>
        <div className="spec-version-card"><Icon name="branch" size={18} /><div><strong>Version {version}</strong><small>{contentHash}</small></div></div>
      </aside>

      <div className="spec-document">
        <Surface className="spec-toolbar">
          <div><StatusBadge tone={statusTone}>{statusLabel}</StatusBadge><span>Last saved {savedAt}</span>{dirty && <strong>Unsaved changes</strong>}</div>
          <div><Button kind="primary" icon="check" disabled={!dirty || saving || conflict} onClick={save}>{saving ? "Saving…" : "Save new version"}</Button></div>
        </Surface>

        {conflict && (
          <div className="conflict-banner" role="alert">
            <Icon name="warning" size={21} />
            <div><strong>This specification changed in another session.</strong><p>Your edit is based on v{version}. Reload canonical state and compare the immutable versions before saving; nothing was overwritten.</p></div>
            <Button onClick={() => window.location.reload()}>Reload versions</Button>
          </div>
        )}

        {notice && <div className="inline-notice" role="status"><Icon name={conflict ? "warning" : "shield"} size={17} /><span>{notice}</span></div>}

        <article className="spec-paper">
          <header><span className="eyebrow">Product specification · v{version}</span><h2>{completeSpec.productName}</h2><div><code>{contentHash}</code><span>Updated {savedAt}</span></div></header>

          <section id="spec-position">
            <span className="section-number">01</span><div><h3>Position</h3><label className="form-field"><span>One-line product</span><textarea rows={2} value={oneLiner} onChange={(event) => { setOneLiner(event.target.value); setDirty(true); }} /></label><label className="form-field"><span>Target user</span><textarea rows={3} value={targetUser} onChange={(event) => { setTargetUser(event.target.value); setDirty(true); }} /></label></div>
          </section>

          <section id="spec-workflow">
            <span className="section-number">02</span><div><h3>Core workflow</h3><ol className="editable-list">{completeSpec.userStories.map((story, index) => { const step = `${story.actor} needs ${story.need} so ${story.outcome}`; return <li key={`${index}-${step}`}><span>{String(index + 1).padStart(2, "0")}</span><p>{step}</p></li>; })}</ol></div>
          </section>

          <section id="spec-features">
            <span className="section-number">03</span><div><h3>Required features</h3><div className="editable-fields">{features.map((feature, index) => <label key={`feature-${index}`}><span className="drag-handle" aria-hidden="true">⠿</span><input aria-label={`Feature ${index + 1}`} value={feature} onChange={(event) => updateFeature(index, event.target.value)} /><Icon name="check" size={16} /></label>)}</div><button className="text-button" onClick={() => { setFeatures((current) => [...current, "New feature requirement"]); setDirty(true); }}><Icon name="plus" size={16} /> Add requirement</button></div>
          </section>

          <section id="spec-nongoals">
            <span className="section-number">04</span><div><h3>Explicit non-goals</h3><ul className="boundary-list">{completeSpec.outOfScope.map((goal) => <li key={goal}><Icon name="x" size={17} />{goal}</li>)}</ul></div>
          </section>

          <section id="spec-acceptance">
            <span className="section-number">05</span><div><h3>Acceptance criteria</h3><ul className="acceptance-list">{completeSpec.acceptanceCriteria.map((criterion) => <li key={criterion}><span><Icon name="check" size={15} /></span>{criterion}</li>)}</ul></div>
          </section>
        </article>

        <Surface className="version-history">
          <div className="surface-head"><div><span className="eyebrow">Immutable history</span><h2>Version lineage</h2></div><Button icon="download" onClick={exportSpec}>Export JSON</Button></div>
          {history.map((item) => { const itemSpec = runtimeSpec(item); const itemStatus = item.status?.toLowerCase() ?? "draft"; return <div className={`version-row ${item.id === specId ? "is-current" : ""}`} key={item.id}><span>v{item.version}</span><div><strong>{itemSpec.oneLinePitch}</strong><small>{item.createdByUserId ? "Owner edit" : item.model ? `TokenRouter · ${item.model}` : "Workspace"}{item.createdAt ? ` · ${new Date(item.createdAt).toLocaleString()}` : ""}</small></div><StatusBadge tone={itemStatus === "approved" ? "success" : itemStatus === "pending_approval" ? "warning" : "neutral"}>{itemStatus.replaceAll("_", " ")}</StatusBadge><code title={item.contentHash ?? item.hash}>{(item.contentHash ?? item.hash ?? "pending").slice(0, 8)}</code></div>; })}
        </Surface>
      </div>
    </div>
  );
}
