"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Icon } from "@/components/icons";
import { Button, Dialog, EmptyState, StatusBadge } from "@/components/ui";
import type { ApprovalStatus } from "@/demo-data/control-plane";

type UiApprovalStatus = ApprovalStatus | "consumed" | "superseded";

type ApiApproval = {
  id: string;
  projectId: string;
  kind: string;
  status: string;
  title?: string;
  summary?: string;
  upstreamLabel?: string;
  payload?: Record<string, unknown>;
  payloadHash: string;
  optimisticVersion?: number;
  expiresAt: string;
  createdAt: string;
};

type UiApproval = {
  id: string;
  projectId: string;
  kind: string;
  projectName: string;
  type: string;
  title: string;
  status: UiApprovalStatus;
  requestedAt: string;
  expires: string;
  summary: string;
  risk: string;
  summaryPayload: Array<[string, string]>;
  canonicalPayload: Record<string, unknown>;
  exactSections: ExactPayloadSection[];
  payloadHash: string;
  optimisticVersion: number;
};

type ExactPayloadField = {
  path: string;
  value: string;
  copyableHash: boolean;
};

type ExactPayloadSection = {
  title: string;
  fields: ExactPayloadField[];
};

const statusTone = { pending: "warning", approved: "success", rejected: "danger", expired: "neutral", consumed: "success", superseded: "neutral" } as const;

const kindLabels: Record<string, string> = {
  specification_build: "Specification build",
  first_release: "First release",
  polish_release: "Polish release",
  secret_grant: "Secret grant",
  rollback: "Rollback",
};

function shortHash(value: unknown) {
  const text = typeof value === "string" ? value : "";
  return text ? `${text.slice(0, 10)}…${text.slice(-6)}` : "Not applicable";
}

function formatCost(value: unknown) {
  return typeof value === "number" ? `$${(value / 1_000_000).toFixed(2)}` : "Bound by approval";
}

function formatProviderAccounts(value: unknown) {
  if (Array.isArray(value)) {
    const labels = value.flatMap((account) => {
      if (typeof account !== "object" || account === null) return [];
      const record = account as Record<string, unknown>;
      return typeof record.provider === "string" && typeof record.accountId === "string"
        ? [`${record.provider}: ${record.accountId}`]
        : [];
    });
    return labels.length ? labels.join(", ") : "None";
  }
  if (typeof value === "object" && value !== null) {
    const labels = Object.entries(value as Record<string, unknown>)
      .filter((entry): entry is [string, string] => typeof entry[1] === "string")
      .map(([provider, account]) => `${provider}: ${account}`);
    return labels.length ? labels.join(", ") : "None";
  }
  return "None";
}

function formatSecretGrants(value: unknown) {
  if (!Array.isArray(value)) return "None";
  const labels = value.flatMap((grant) => {
    if (typeof grant !== "object" || grant === null) return [];
    const record = grant as Record<string, unknown>;
    return typeof record.name === "string" && typeof record.version === "number"
      ? [`${record.name} v${record.version}`]
      : [];
  });
  return labels.length ? labels.join(", ") : "None";
}

function recordValue(value: unknown) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function exactValue(value: unknown) {
  if (typeof value === "string") return value;
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  return JSON.stringify(value);
}

function flattenExactPayload(value: unknown, path = ""): ExactPayloadField[] {
  if (Array.isArray(value)) {
    if (value.length === 0) return [{ path, value: "[]", copyableHash: false }];
    return value.flatMap((item, index) => flattenExactPayload(item, `${path}[${index}]`));
  }
  const object = recordValue(value);
  if (object) {
    const entries = Object.entries(object).sort(([left], [right]) => left.localeCompare(right));
    if (entries.length === 0) return [{ path, value: "{}", copyableHash: false }];
    return entries.flatMap(([key, item]) => flattenExactPayload(item, path ? `${path}.${key}` : key));
  }
  return [{ path, value: exactValue(value), copyableHash: /hash/i.test(path) && typeof value === "string" }];
}

function exactPayloadSections(record: ApiApproval, payload: Record<string, unknown>): ExactPayloadSection[] {
  const remaining = new Map(flattenExactPayload(payload).map((field) => [field.path, field]));
  const sections: ExactPayloadSection[] = [
    {
      title: "Approval record",
      fields: [
        { path: "approval.id", value: record.id, copyableHash: false },
        { path: "approval.payloadHash", value: record.payloadHash, copyableHash: true },
        { path: "approval.optimisticVersion", value: String(record.optimisticVersion ?? 0), copyableHash: false },
        { path: "approval.expiresAt", value: record.expiresAt, copyableHash: false },
      ],
    },
  ];

  const take = (title: string, predicate: (path: string) => boolean) => {
    const fields = [...remaining.values()].filter((field) => predicate(field.path));
    if (!fields.length) return;
    fields.forEach((field) => remaining.delete(field.path));
    sections.push({ title, fields });
  };

  take("Identity and version fence", (path) => /^(id|kind|workspaceId|projectId|projectOptimisticVersion|optimisticVersions)(\.|\[|$)/.test(path));
  take("Specification", (path) => /^spec[A-Z]|^spec\./.test(path));
  take("Artifact and signed verification", (path) => /^(artifact|verificationReport)/.test(path));
  take("Provider accounts", (path) => /^providerAccounts(\.|\[|$)/.test(path));
  take("Repository target", (path) => /^repository(\.|\[|Visibility|$)/.test(path));
  take("Deployment and rollback target", (path) => /^(deployment|deploymentTarget|targetDeployment|previousDeployment|previousArtifact)/.test(path));
  take("Exact runtime secret grants", (path) => /^secretGrants(\.|\[|$)/.test(path));
  take("Budget and expiry", (path) => /^(costCeiling|expiresAt)/.test(path));
  if (remaining.size) sections.push({ title: "Additional canonical fields", fields: [...remaining.values()] });
  return sections;
}

function stableJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableJsonValue);
  const object = recordValue(value);
  if (!object) return value;
  return Object.fromEntries(
    Object.entries(object)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, stableJsonValue(item)]),
  );
}

function compactId(value: unknown) {
  const text = typeof value === "string" ? value : "";
  return text.length > 28 ? `${text.slice(0, 14)}…${text.slice(-8)}` : text || "Not applicable";
}

function summaryPayload(kind: string, payload: Record<string, unknown>, payloadHash: string): Array<[string, string]> {
  const repository = recordValue(payload.repository);
  const deployment = recordValue(payload.deployment ?? payload.deploymentTarget);
  const costMicros = typeof payload.costCeilingMicros === "number"
    ? payload.costCeilingMicros
    : typeof payload.costCeilingCents === "number"
      ? payload.costCeilingCents * 10_000
      : undefined;
  const specVersion = typeof payload.specVersion === "number" ? `v${payload.specVersion} · ` : "";
  const artifact = payload.artifactHash ? shortHash(payload.artifactHash) : "Not applicable";
  const providers = formatProviderAccounts(payload.providerAccounts);
  const cost = formatCost(costMicros);
  const integrity: [string, string] = ["Payload hash", shortHash(payloadHash)];

  if (kind === "rollback") {
    return [
      ["Current deployment", `${compactId(payload.deploymentId)} · v${String(payload.deploymentOptimisticVersion ?? 0)}`],
      ["Rollback target", compactId(payload.targetDeploymentId)],
      ["Target artifact", shortHash(payload.targetArtifactHash)],
      ["Provider accounts", providers],
      ["Cost ceiling", cost],
      integrity,
    ];
  }
  if (kind === "secret_grant") {
    return [
      ["Verified artifact", artifact],
      ["Verification report", shortHash(payload.verificationReportHash)],
      ["Exact grants", formatSecretGrants(payload.secretGrants)],
      ["Provider accounts", providers],
      ["Cost ceiling", cost],
      integrity,
    ];
  }
  if (kind === "first_release" || kind === "polish_release") {
    return [
      ["Specification", `${specVersion}${shortHash(payload.specHash)}`],
      ["Verified artifact", artifact],
      ["Verified source", `${compactId(payload.sourceArtifactId)} · ${shortHash(payload.sourceArtifactHash)}`],
      ["Repository", repository ? `${String(repository.owner ?? "owner")}/${String(repository.name ?? "project")} · ${String(repository.visibility ?? "private")}` : String(payload.repositoryVisibility ?? "private")],
      ["Deployment", deployment ? `${String(deployment.teamId ?? "team")} / ${String(deployment.projectId ?? "project")} · ${String(deployment.environment ?? "production")}` : "Not applicable"],
      ["Ownership markers", `${String(repository?.ownershipMarker ?? "missing")} · ${String(deployment?.ownershipMarker ?? "missing")}`],
      ...(kind === "polish_release" ? [["Previous artifact", shortHash(payload.previousArtifactHash)] as [string, string]] : []),
      ["Exact grants", formatSecretGrants(payload.secretGrants)],
      ["Provider accounts", providers],
      ["Cost ceiling", cost],
      integrity,
    ];
  }
  return [
    ["Specification", `${specVersion}${shortHash(payload.specHash)}`],
    ["Spec version ID", compactId(payload.specVersionId)],
    ["Provider accounts", providers],
    ["Project version", String(payload.projectOptimisticVersion ?? recordValue(payload.optimisticVersions)?.project ?? "Not applicable")],
    ["Cost ceiling", cost],
    integrity,
  ];
}

function normalizeApproval(record: ApiApproval): UiApproval {
  const kind = record.kind.toLowerCase();
  const payload = record.payload ?? {};
  const label = kindLabels[kind] ?? capitalize(kind.replaceAll("_", " "));
  return {
    id: record.id,
    projectId: record.projectId,
    kind,
    projectName: "Workspace project",
    type: label,
    title: record.title ?? (kind === "specification_build" ? "Approve specification for build" : kind === "secret_grant" ? "Approve exact runtime secret versions" : kind === "rollback" ? "Approve rollback target" : "Approve verified release"),
    status: record.status.toLowerCase() as UiApprovalStatus,
    requestedAt: new Date(record.createdAt).toLocaleString(),
    expires: `Expires ${new Date(record.expiresAt).toLocaleString()}`,
    summary: record.summary ?? (kind === "specification_build" ? "Start one bounded builder run from this exact specification." : kind === "secret_grant" ? "Authorize these exact project secret versions for the bound verified artifact. No plaintext is included in this payload." : "Consume this exact verified artifact and release target in one durable workflow."),
    risk: kind === "specification_build" ? "This reserves model and sandbox budget; it cannot release to production." : kind === "secret_grant" ? "Generated runtime code can read approved values. Review every exact name and version before approval." : "This can create or change external resources and incur provider usage.",
    summaryPayload: summaryPayload(kind, payload, record.payloadHash),
    canonicalPayload: payload,
    exactSections: exactPayloadSections(record, payload),
    payloadHash: record.payloadHash,
    optimisticVersion: record.optimisticVersion ?? 0,
  };
}

async function fetchApprovalItems() {
  const response = await fetch("/api/v1/approvals", { headers: { accept: "application/json" } });
  const body = await response.json() as { data?: { items?: ApiApproval[] }; error?: { message?: string } };
  if (!response.ok) throw new Error(body.error?.message ?? "Approvals are unavailable.");
  return (body.data?.items ?? []).map(normalizeApproval);
}

function resolvedStatus(value: unknown, fallback: UiApprovalStatus): UiApprovalStatus {
  const normalized = typeof value === "string" ? value.toLowerCase() : "";
  return normalized in statusTone ? normalized as UiApprovalStatus : fallback;
}

function capitalize(value: string) {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}

export function ApprovalQueue() {
  const [filter, setFilter] = useState<"all" | ApprovalStatus>("pending");
  const [approvals, setApprovals] = useState<UiApproval[]>([]);
  const [statuses, setStatuses] = useState<Record<string, UiApprovalStatus>>({});
  const [decision, setDecision] = useState<{ id: string; action: "approve" | "reject" } | null>(null);
  const [reason, setReason] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(true);
  const [resolving, setResolving] = useState(false);
  const [copiedField, setCopiedField] = useState("");

  function replaceQueue(items: UiApproval[]) {
    setApprovals(items);
    setStatuses(Object.fromEntries(items.map((approval) => [approval.id, approval.status])));
  }

  useEffect(() => {
    let active = true;
    fetchApprovalItems()
      .then((items) => {
        if (!active) return;
        replaceQueue(items);
      })
      .catch((error: unknown) => { if (active) setNotice(error instanceof Error ? error.message : "Approvals are unavailable."); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  const visible = approvals.filter((item) => filter === "all" || (statuses[item.id] ?? item.status) === filter);
  const item = decision ? approvals.find((approval) => approval.id === decision.id) : null;

  function closeDecision() {
    setDecision(null);
    setReason("");
    setCopiedField("");
  }

  async function copyExactValue(key: string, value: string) {
    try {
      if (!navigator.clipboard) throw new Error("Clipboard access is unavailable.");
      await navigator.clipboard.writeText(value);
      setCopiedField(key);
      window.setTimeout(() => setCopiedField((current) => current === key ? "" : current), 1_500);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "The value could not be copied.");
    }
  }

  async function resolve() {
    if (!decision || !item) return;
    if (decision.action === "reject" && reason.trim().length < 8) return;
    setResolving(true);
    try {
      const response = await fetch(`/api/v1/approvals/${item.id}/resolve`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": `approval-${crypto.randomUUID()}`,
          "if-match": String(item.optimisticVersion),
        },
        body: JSON.stringify({
          decision: decision.action === "approve" ? "approved" : "rejected",
          ...(decision.action === "reject" ? { reason: reason.trim() } : {}),
          payloadHash: item.payloadHash,
          optimisticVersion: item.optimisticVersion,
        }),
      });
      const body = await response.json().catch(() => null) as { data?: { approval?: { status?: string } }; error?: { message?: string } } | null;
      if (!response.ok) throw new Error(body?.error?.message ?? "The approval could not be resolved.");
      const fallback: UiApprovalStatus = decision.action === "approve" ? "approved" : "rejected";
      const status = resolvedStatus(body?.data?.approval?.status, fallback);
      setStatuses((current) => ({ ...current, [decision.id]: status }));
      const successNotice = decision.action === "approve" ? `${item.title} was ${status === "consumed" ? "consumed" : "approved"}. The exact payload is now bound to its one authorized transition.` : `${item.title} was rejected. The immutable payload and reason were preserved.`;
      closeDecision();
      try {
        replaceQueue(await fetchApprovalItems());
        setNotice(successNotice);
      } catch {
        setNotice(`${successNotice} Refresh the queue to load any newly generated approval.`);
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "The approval could not be resolved.");
    } finally {
      setResolving(false);
    }
  }

  return (
    <>
      {notice && <div className="inline-notice notice-success" role="status"><Icon name="check" size={17} /><span>{notice}</span><button aria-label="Dismiss notice" onClick={() => setNotice("")}><Icon name="close" size={16} /></button></div>}
      <div className="approval-toolbar">
        <div className="segmented-control" role="group" aria-label="Filter approvals">
          {(["pending", "all", "approved", "rejected"] as const).map((value) => <button aria-pressed={filter === value} className={filter === value ? "is-active" : ""} key={value} onClick={() => setFilter(value)}>{capitalize(value)}{value === "pending" && <span>{Object.values(statuses).filter((status) => status === "pending").length}</span>}</button>)}
        </div>
        <span className="approval-policy"><Icon name="shield" size={17} />Payloads are canonical, version-bound, and single-use.</span>
      </div>

      {visible.length ? <div className="approval-list">
        {visible.map((approval) => {
          const status = statuses[approval.id] ?? approval.status;
          return (
            <article className={`approval-card is-${status}`} key={approval.id}>
              <div className="approval-card-rail"><span><Icon name={approval.type === "Secret grant" ? "key" : approval.type.includes("release") || approval.type.includes("Release") ? "globe" : "terminal"} size={22} /></span><i /></div>
              <div className="approval-card-main">
                <div className="approval-card-head"><div><span className="eyebrow">{approval.type} · {approval.projectName}</span><h2>{approval.title}</h2></div><StatusBadge tone={statusTone[status]}>{capitalize(status)}</StatusBadge></div>
                <p className="approval-summary">{approval.summary}</p>
                <div className="approval-risk"><Icon name="warning" size={18} /><span>{approval.risk}</span></div>
                <dl className="approval-payload">
                  {approval.summaryPayload.map(([key, value]) => <div key={key}><dt>{key}</dt><dd title={value}>{value}</dd></div>)}
                </dl>
                <div className="approval-card-footer"><div><span><Icon name="clock" size={15} />Requested {approval.requestedAt}</span><span>{approval.expires}</span></div>{status === "pending" ? <div><Button icon="x" onClick={() => { setCopiedField(""); setDecision({ id: approval.id, action: "reject" }); }}>Reject</Button><Button kind="primary" icon="check" onClick={() => { setCopiedField(""); setDecision({ id: approval.id, action: "approve" }); }}>Review and approve</Button></div> : <Link href={`/projects/${approval.projectId}`}>Open upstream artifact <Icon name="arrow-right" size={16} /></Link>}</div>
              </div>
            </article>
          );
        })}
      </div> : <EmptyState icon="approval" title={loading ? "Loading approvals" : `No ${filter} approvals`} description={loading ? "Reading canonical approval payloads from the workspace." : "Approvals will appear here when a specification, build, release, secret grant, or rollback reaches a human gate."} />}

      {decision && item && (
        <Dialog
          className={`decision-dialog-frame decision-${decision.action}`}
          contentClassName="decision-dialog-surface"
          description={decision.action === "approve" ? "The approval is bound to the hashes, accounts, visibility, environment, grants, cost ceiling, and expiry shown below. Any change makes it stale." : "The payload remains immutable. Add a reason and ReDDone will link back to the single upstream artifact that should change."}
          footer={<><Button disabled={resolving} onClick={closeDecision}>Cancel</Button><Button kind={decision.action === "approve" ? "primary" : "danger"} icon={decision.action === "approve" ? "check" : "x"} disabled={resolving || (decision.action === "reject" && reason.trim().length < 8)} onClick={resolve}>{resolving ? "Resolving…" : decision.action === "approve" ? "Approve payload" : "Reject with reason"}</Button></>}
          onOpenChange={(open) => { if (!open && !resolving) closeDecision(); }}
          open
          title={decision.action === "approve" ? "Approve this exact payload?" : "Reject this request?"}
        >
            <span className="confirm-icon"><Icon name={decision.action === "approve" ? "shield" : "x"} size={25} /></span>
            <span className="eyebrow">{decision.action === "approve" ? "Consume one approval" : "Preserve rejection context"}</span>
            <div className="decision-summary" style={{ maxHeight: "48dvh", overflowY: "auto" }}>
              <div style={{ alignItems: "center", display: "flex", justifyContent: "space-between", gap: 12 }}>
                <strong>{item.title}</strong>
                <Button kind="ghost" icon="copy" type="button" onClick={() => copyExactValue("canonical-json", JSON.stringify(stableJsonValue(item.canonicalPayload), null, 2))}>{copiedField === "canonical-json" ? "Copied JSON" : "Copy payload JSON"}</Button>
              </div>
              {item.exactSections.map((section) => (
                <section key={section.title} aria-label={section.title} style={{ borderTop: "1px solid var(--line)", marginTop: 10, paddingTop: 10 }}>
                  <h3 style={{ color: "var(--text-tertiary)", font: "650 9px/1.2 var(--font-mono)", letterSpacing: ".06em", margin: "0 0 8px", textTransform: "uppercase" }}>{section.title}</h3>
                  <dl style={{ display: "grid", gap: 6, margin: 0 }}>
                    {section.fields.map((field) => {
                      const copyKey = `${section.title}:${field.path}`;
                      return (
                        <div key={field.path} style={{ alignItems: "start", display: "grid", gap: 10, gridTemplateColumns: "minmax(150px, .75fr) minmax(0, 1.25fr)", padding: "6px 0" }}>
                          <dt style={{ color: "var(--text-tertiary)", minWidth: 0 }}><code style={{ overflowWrap: "anywhere" }}>{field.path}</code></dt>
                          <dd style={{ alignItems: "start", color: "var(--text-secondary)", display: "flex", gap: 8, justifyContent: "space-between", margin: 0, minWidth: 0 }}>
                            <code style={{ color: field.copyableHash ? "var(--accent-200)" : "inherit", overflowWrap: "anywhere", whiteSpace: "normal", wordBreak: field.copyableHash ? "break-all" : "normal" }}>{field.value}</code>
                            {field.copyableHash && <button aria-label={`Copy full ${field.path}`} className="icon-button" onClick={() => copyExactValue(copyKey, field.value)} title={`Copy full ${field.path}`} type="button" style={{ flex: "0 0 auto", height: 44, minHeight: 44, width: 44 }}><Icon name={copiedField === copyKey ? "check" : "copy"} size={16} /></button>}
                          </dd>
                        </div>
                      );
                    })}
                  </dl>
                </section>
              ))}
            </div>
            {decision.action === "reject" && <label className="form-field"><span>Rejection reason</span><textarea autoFocus rows={3} placeholder="What must change before this can be resubmitted?" value={reason} onChange={(event) => setReason(event.target.value)} /><small>At least 8 characters. This becomes part of the audit record.</small></label>}
        </Dialog>
      )}
    </>
  );
}
