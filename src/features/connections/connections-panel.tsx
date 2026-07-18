"use client";

import { useEffect, useState, type FormEvent } from "react";
import { Icon } from "@/components/icons";
import { Button, Dialog, IconButton, StatusBadge } from "@/components/ui";
import { providerConnections } from "@/demo-data/control-plane";

const accountConnections = providerConnections.filter((provider) => provider.id === "github" || provider.id === "vercel");

type ProviderStatus = "connected" | "attention" | "locked" | "testing" | "disconnected";

type ConnectionRecord = {
  provider: string;
  status?: string;
  health?: string;
  account?: string | null;
  accountLabel?: string | null;
  scopes?: string[];
  maskedSuffix?: string | null;
  lastTestedAt?: string | null;
  optimisticVersion?: number;
};

const disconnectedStatuses: Record<string, ProviderStatus> = Object.fromEntries(
  accountConnections.map((provider) => [provider.id, "disconnected"]),
);

function idempotencyKey(prefix: string) {
  return `${prefix}-${crypto.randomUUID()}`;
}

function connectionStatus(record: ConnectionRecord): ProviderStatus {
  const value = (record.health ?? record.status ?? "disconnected").toLowerCase();
  if (value === "healthy") return "connected";
  if (value === "locked") return "locked";
  if (value === "disconnected" || value === "revoked" || value === "disabled") return "disconnected";
  return "attention";
}

async function apiData<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => null) as { data?: T; error?: { message?: string } } | null;
  if (!response.ok) throw new Error(body?.error?.message ?? `Request failed (${response.status}).`);
  if (!body || !("data" in body)) throw new Error("The server returned an invalid response.");
  return body.data as T;
}

const providerIcons = {
  kimi: "spark",
  daytona: "terminal",
  github: "branch",
  vercel: "globe",
  reddit: "activity",
} as const;

const providerTone = {
  connected: "success",
  attention: "warning",
  locked: "neutral",
  testing: "info",
  disconnected: "neutral",
} as const;

const providerLabel = {
  connected: "Healthy",
  attention: "Needs attention",
  locked: "Authorization required",
  testing: "Testing…",
  disconnected: "Disconnected",
};

function initialConnectionNotice() {
  if (typeof window === "undefined") return "All provider credentials are hidden from generated applications.";
  const query = new URLSearchParams(window.location.search);
  const callbackProvider = query.get("connection");
  const outcome = query.get("outcome");
  if (!callbackProvider || !outcome) return "All provider credentials are hidden from generated applications.";
  const name = accountConnections.find((provider) => provider.id === callbackProvider)?.name ?? callbackProvider;
  const messages: Record<string, string> = {
    connected: `${name} connected successfully. Canonical account and scope details were refreshed.`,
    consent_canceled: `${name} consent was canceled. No connection was saved.`,
    wrong_account: `${name} authorized the wrong account or team. Reconnect with the configured workspace account.`,
    insufficient_scopes: `${name} did not grant the required scopes. Update the installation and reconnect.`,
    callback_error: `${name} could not complete authorization. No new connection was activated.`,
  };
  return messages[outcome] ?? `${name} authorization returned ${outcome.replaceAll("_", " ")}.`;
}

function ConnectionDialog({ providerId, mode, expectedVersion, onClose, onSaved }: { providerId: string; mode: "secret" | "oauth"; expectedVersion: number; onClose: () => void; onSaved: (record: ConnectionRecord) => void }) {
  const provider = accountConnections.find((item) => item.id === providerId)!;
  const [secret, setSecret] = useState("");
  const [redditClientId, setRedditClientId] = useState("");
  const [redditUserAgent, setRedditUserAgent] = useState("");
  const [redditApprovalReference, setRedditApprovalReference] = useState("");
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (mode === "oauth") {
      setSaving(true);
      window.location.assign(`/api/integrations/${providerId}/start?returnTo=${encodeURIComponent("/connections")}`);
      return;
    }
    if (mode === "secret" && providerId !== "reddit" && secret.trim().length < 12) {
      setNotice("Paste the complete provider credential. Short values are not accepted.");
      return;
    }
    if (
      providerId === "reddit"
      && (redditClientId.trim().length < 4
        || secret.trim().length < 8
        || redditUserAgent.trim().length < 8
        || redditApprovalReference.trim().length < 3)
    ) {
      setNotice("Client ID, client secret, descriptive user agent, and written authorization reference are all required.");
      return;
    }
    setSaving(true);
    setNotice("");
    try {
      const response = await fetch(`/api/v1/connections/${providerId}`, {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          "idempotency-key": idempotencyKey(`connection-${providerId}`),
          "if-match": String(expectedVersion),
        },
        body: JSON.stringify({
          credential: providerId === "reddit"
            ? JSON.stringify({ clientId: redditClientId.trim(), clientSecret: secret, userAgent: redditUserAgent.trim() })
            : secret,
          accountLabel: "Workspace owner",
          ...(providerId === "reddit" ? { redditAuthorizationReference: redditApprovalReference.trim() } : {}),
        }),
      });
      const record = await apiData<ConnectionRecord>(response);
      setSecret("");
      onSaved(record);
      onClose();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "The connection could not be saved.");
      setSaving(false);
    }
  }

  return (
    <Dialog
      className="connection-dialog-frame"
      contentClassName="connection-dialog-surface"
      description={mode === "oauth" ? "Provider authorization" : "Write-only credential"}
      footer={<><Button type="button" onClick={onClose}>Cancel</Button><Button form="connection-dialog-form" kind="primary" icon={mode === "oauth" ? "external" : "shield"} disabled={saving} type="submit">{saving ? "Verifying…" : mode === "oauth" ? `Continue to ${provider.name}` : "Encrypt and save"}</Button></>}
      onOpenChange={(open) => { if (!open) onClose(); }}
      open
      title={mode === "oauth" ? `Connect ${provider.name}` : `Replace ${provider.name} key`}
    >
      <form className="connection-dialog-form" id="connection-dialog-form" onSubmit={submit}>
        <span className="provider-icon connection-dialog-provider"><Icon name={providerIcons[providerId as keyof typeof providerIcons]} size={24} /></span>
        {mode === "secret" ? (
          <>
            <div className="secret-explainer"><Icon name="shield" size={21} /><p><strong>The value is write-only.</strong> After saving, ReDDone shows only a masked suffix. It is encrypted before storage and excluded from browser responses, logs, prompts, and sandboxes.</p></div>
            {providerId === "reddit" && <label className="form-field"><span>Approved app client ID</span><input autoFocus autoComplete="off" onChange={(event) => { setRedditClientId(event.target.value); setNotice(""); }} placeholder="OAuth client ID" value={redditClientId} /><small>Use only the app covered by the recorded authorization.</small></label>}
            <label className="form-field"><span>{providerId === "reddit" ? "Approved app client secret" : `${provider.name} API key`}</span><input autoFocus={providerId !== "reddit"} autoComplete="off" onChange={(event) => { setSecret(event.target.value); setNotice(""); }} placeholder={`Paste ${provider.name} credential`} type="password" value={secret} /><small>Paste is allowed. The value will not be shown again.</small></label>
            {providerId === "reddit" && <><label className="form-field"><span>Descriptive user agent</span><input autoComplete="off" onChange={(event) => { setRedditUserAgent(event.target.value); setNotice(""); }} placeholder="web:your-app:v1 (by /u/owner)" value={redditUserAgent} /></label><label className="form-field"><span>Written authorization reference</span><input autoComplete="off" onChange={(event) => { setRedditApprovalReference(event.target.value); setNotice(""); }} placeholder="Agreement or approval ticket reference" value={redditApprovalReference} /><small>ReDDone records the reference, not the agreement text. Commercial and downstream AI use must be covered.</small></label></>}
            {notice && <div className="inline-error" role="alert"><Icon name="warning" size={17} />{notice}</div>}
            <div className="credential-route"><span><Icon name="key" size={17} /> Stored as a control-plane credential</span><Icon name="arrow-right" size={17} /><span><Icon name="lock" size={17} /> Never grantable to generated apps</span></div>
          </>
        ) : (
          <>
            <div className="oauth-account"><span className="oauth-orbit"><Icon name={providerId === "github" ? "branch" : "globe"} size={27} /></span><div><strong>{providerId === "github" ? "Install the ReDDone GitHub App" : "Authorize the ReDDone Vercel integration"}</strong><p>{providerId === "github" ? "Choose the organization where private generated repositories may be created." : "Choose exactly one team for prebuilt project deployments."}</p></div></div>
            <div className="scope-list"><span>Requested access</span>{provider.scopes.map((scope) => <code key={scope}>{scope}</code>)}</div>
            <div className="oauth-note"><Icon name="warning" size={18} /><p>If the popup is blocked or consent is canceled, no connection is saved. Wrong-account and insufficient-scope responses return here with a specific recovery action.</p></div>
          </>
        )}

      </form>
    </Dialog>
  );
}

export function ConnectionsPanel() {
  const [statuses, setStatuses] = useState<Record<string, ProviderStatus>>(() => ({ ...disconnectedStatuses }));
  const [records, setRecords] = useState<Record<string, ConnectionRecord>>({});
  const [loaded, setLoaded] = useState(false);
  const [dialog, setDialog] = useState<{ providerId: string; mode: "secret" | "oauth" } | null>(null);
  const [event, setEvent] = useState(initialConnectionNotice);

  useEffect(() => {
    const query = new URLSearchParams(window.location.search);
    if (query.has("connection") || query.has("outcome")) window.history.replaceState({}, "", window.location.pathname);
    let active = true;
    fetch("/api/v1/connections", { headers: { accept: "application/json" } })
      .then((response) => apiData<{ items: ConnectionRecord[] }>(response))
      .then(({ items }) => {
        if (!active) return;
        setStatuses({
          ...disconnectedStatuses,
          ...Object.fromEntries(items.map((record) => [record.provider, connectionStatus(record)])),
        });
        setRecords(Object.fromEntries(items.map((record) => [record.provider, record])));
      })
      .catch((error: unknown) => {
        if (active) setEvent(error instanceof Error ? `Connection status unavailable: ${error.message}` : "Connection status is unavailable.");
      })
      .finally(() => { if (active) setLoaded(true); });
    return () => { active = false; };
  }, []);

  async function refresh(providerId: string) {
    try {
      const record = await apiData<ConnectionRecord>(await fetch(`/api/v1/connections/${providerId}`, {
        headers: { accept: "application/json" },
      }));
      setRecords((current) => ({ ...current, [providerId]: record }));
      setStatuses((current) => ({ ...current, [providerId]: connectionStatus(record) }));
    } catch {
      setRecords((current) => ({ ...current, [providerId]: { provider: providerId, optimisticVersion: 0 } }));
      setStatuses((current) => ({ ...current, [providerId]: providerId === "reddit" ? "locked" : "disconnected" }));
    }
  }

  async function test(providerId: string) {
    const provider = accountConnections.find((item) => item.id === providerId);
    setStatuses((current) => ({ ...current, [providerId]: "testing" }));
    setEvent(`Testing ${accountConnections.find((provider) => provider.id === providerId)?.name} with a redacted request…`);
    try {
      const response = await fetch(`/api/v1/connections/${providerId}/test`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": idempotencyKey(`test-${providerId}`),
          "if-match": String(records[providerId]?.optimisticVersion ?? 0),
        },
        body: "{}",
      });
      const record = await apiData<ConnectionRecord>(response);
      setRecords((current) => ({ ...current, [providerId]: record }));
      setStatuses((current) => ({ ...current, [providerId]: connectionStatus(record) }));
      setEvent(`${provider?.name} responded. No secret value entered the activity log.`);
    } catch (error) {
      await refresh(providerId);
      setEvent(`${provider?.name} test failed: ${error instanceof Error ? error.message : "Unknown provider error."}`);
    }
  }

  async function disconnect(providerId: string) {
    const name = accountConnections.find((provider) => provider.id === providerId)?.name;
    if (!window.confirm(`Disconnect ${name}? Active runs keep their current lease, but future runs will stop at the connection gate.`)) return;
    try {
      const response = await fetch(`/api/v1/connections/${providerId}`, {
        method: "DELETE",
        headers: {
          "idempotency-key": idempotencyKey(`disconnect-${providerId}`),
          "if-match": String(records[providerId]?.optimisticVersion ?? 0),
        },
      });
      const record = await apiData<ConnectionRecord>(response);
      setRecords((current) => ({ ...current, [providerId]: { ...record, provider: providerId, status: "disconnected", maskedSuffix: null, account: null, lastTestedAt: null } }));
      setStatuses((current) => ({ ...current, [providerId]: "disconnected" }));
      setEvent(`${name} was disconnected. Stored credential versions are now revoked.`);
    } catch (error) {
      await refresh(providerId);
      setEvent(`${name} could not be disconnected: ${error instanceof Error ? error.message : "Unknown error."}`);
    }
  }

  return (
    <>
      <div className="connection-summary">
        <div className="connection-map" aria-label="Connection boundary illustration">
          <div className="control-core"><span><Icon name="shield" size={26} /></span><strong>ReDDone</strong><small>control plane</small></div>
          <span className="map-line line-one" /><span className="map-line line-two" />
          <div className="map-node node-one"><Icon name="branch" size={19} /><span>GitHub</span></div>
          <div className="map-node node-two"><Icon name="globe" size={19} /><span>Vercel</span></div>
        </div>
        <div><span className="eyebrow">Account connections</span><h2>Connect source and release accounts.</h2><p>GitHub and Vercel authorization stays attached to the owner workspace. AIand inference, Daytona, and Oxylabs discovery are configured separately by the backend operator.</p><div className="connection-stats"><span><strong>{Object.values(statuses).filter((status) => status === "connected").length}</strong> healthy</span><span><strong>{Object.values(statuses).filter((status) => status === "attention").length}</strong> attention</span></div></div>
      </div>

      <div className="inline-notice" aria-live="polite"><Icon name="shield" size={17} /><span>{event}</span></div>

      <div className="connections-list">
        {accountConnections.map((provider) => {
          const status: ProviderStatus = statuses[provider.id] ?? (provider.id === "reddit" ? "locked" : "disconnected");
          const record = records[provider.id];
          const account = record?.accountLabel ?? record?.account ?? (loaded ? "No account" : "Loading…");
          const suffix = record?.maskedSuffix ?? "Not stored";
          const testedAt = record?.lastTestedAt ? new Date(record.lastTestedAt).toLocaleString() : "Never";
          const scopes = record?.scopes?.length ? record.scopes : provider.scopes;
          return (
            <article className={`connection-row connection-${status}`} key={provider.id}>
              <div className="provider-identity"><span className="provider-icon"><Icon name={providerIcons[provider.id as keyof typeof providerIcons]} size={23} /></span><div><h3>{provider.name}</h3><p>{provider.role}</p></div></div>
              <div className="connection-health"><StatusBadge tone={providerTone[status]} pulse={status === "testing"}>{providerLabel[status]}</StatusBadge><span>{status === "disconnected" ? "No account" : account}</span></div>
              <div className="connection-detail"><span>Credential</span><strong>{status === "disconnected" ? "Not stored" : suffix}</strong><small>{status === "disconnected" ? "Connect to use" : `Tested ${testedAt}`}</small></div>
              <div className="connection-detail scope-detail"><span>{status === "disconnected" || status === "locked" ? "Required scopes" : "Allowed scopes"}</span><div>{scopes.map((scope) => <code key={scope}>{scope}</code>)}</div></div>
              <div className="connection-actions">
                {status !== "locked" && status !== "disconnected" && <Button disabled={status === "testing"} icon="activity" onClick={() => test(provider.id)}>{status === "testing" ? "Testing…" : "Test"}</Button>}
                {status !== "locked" && <Button icon={status === "disconnected" ? "plus" : "key"} onClick={() => setDialog({ providerId: provider.id, mode: "oauth" })}>{status === "disconnected" ? "Connect" : "Replace"}</Button>}
                {status !== "locked" && status !== "disconnected" && <IconButton icon="trash" label={`Disconnect ${provider.name}`} onClick={() => disconnect(provider.id)} />}
              </div>
            </article>
          );
        })}
      </div>

      <div className="connection-help-grid">
        <div><Icon name="lock" size={20} /><span><strong>Write-only by design</strong><p>Responses include health, account, scopes, and masked suffix, never plaintext.</p></span></div>
        <div><Icon name="retry" size={20} /><span><strong>Safe reconnection</strong><p>A replacement becomes active only after its provider test passes.</p></span></div>
        <div><Icon name="activity" size={20} /><span><strong>Revocation aware</strong><p>Failed tests stop new work and point to the exact account or scope issue.</p></span></div>
      </div>

      {dialog && <ConnectionDialog expectedVersion={records[dialog.providerId]?.optimisticVersion ?? 0} mode={dialog.mode} providerId={dialog.providerId} onClose={() => setDialog(null)} onSaved={(record) => { setStatuses((current) => ({ ...current, [dialog.providerId]: connectionStatus(record) })); setRecords((current) => ({ ...current, [dialog.providerId]: record })); setEvent(`${accountConnections.find((provider) => provider.id === dialog.providerId)?.name} authorization was saved. Test it before starting provider work.`); }} />}
    </>
  );
}
