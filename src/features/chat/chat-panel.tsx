"use client";

import Link from "next/link";
import { useEffect, useMemo, useState, type FormEvent } from "react";

import { Icon } from "@/components/icons";
import { Button, ButtonLink, EmptyState, StatusBadge } from "@/components/ui";

type ProjectThread = { id: string; name: string; status: string; nextAction: string; optimisticVersion: number };
type Message = { id: string; role: "owner" | "agent"; author: string; time: string; body: string };

const secretPatterns = [
  /(?:sk|key|token|secret)[-_][a-z0-9_-]{12,}/i,
  /gh[pousr]_[a-z0-9]{20,}/i,
  /(?:bearer\s+)[a-z0-9._-]{16,}/i,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
];

async function responseData<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => null) as { data?: T; error?: { message?: string } } | null;
  if (!response.ok || !body || !("data" in body)) throw new Error(body?.error?.message ?? `Request failed (${response.status}).`);
  return body.data as T;
}

function normalizeProject(record: Record<string, unknown>): ProjectThread | null {
  if (typeof record.id !== "string" || typeof record.name !== "string") return null;
  return {
    id: record.id,
    name: record.name,
    status: typeof record.status === "string" ? record.status.toLowerCase() : "draft",
    nextAction: typeof record.nextAction === "string"
      ? record.nextAction
      : typeof record.currentBlocker === "string"
        ? record.currentBlocker
        : typeof record.blocker === "string"
          ? record.blocker
          : "Review project state",
    optimisticVersion: typeof record.optimisticVersion === "number"
      ? record.optimisticVersion
      : typeof record.version === "number"
        ? record.version
        : 0,
  };
}

export function ChatPanel() {
  const [projects, setProjects] = useState<ProjectThread[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Record<string, Message[]>>({});
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    let active = true;
    fetch("/api/v1/projects", { headers: { accept: "application/json" } })
      .then((response) => responseData<{ items: Array<Record<string, unknown>> }>(response))
      .then(({ items }) => {
        if (!active) return;
        const normalized = items.map(normalizeProject).filter((project): project is ProjectThread => Boolean(project));
        setProjects(normalized);
        const requestedProjectId = new URLSearchParams(window.location.search).get("projectId");
        setSelectedId((current) => current ?? normalized.find((project) => project.id === requestedProjectId)?.id ?? normalized[0]?.id ?? null);
      })
      .catch((caught: unknown) => { if (active) setError(caught instanceof Error ? caught.message : "Project threads are unavailable."); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  const selected = projects.find((project) => project.id === selectedId) ?? null;
  const selectedMessages = useMemo(() => selectedId ? messages[selectedId] ?? [] : [], [messages, selectedId]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const text = draft.trim();
    if (!text || !selected || sending) return;
    if (secretPatterns.some((pattern) => pattern.test(text))) {
      setError("That looks like a credential. It was not sent or stored. Add provider keys from Connections instead.");
      return;
    }
    setSending(true);
    setError("");
    try {
      const result = await responseData<{ reply: string; persisted: boolean }>(await fetch("/api/v1/chat", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": `chat-${crypto.randomUUID()}`,
          "if-match": String(selected.optimisticVersion),
        },
        body: JSON.stringify({ message: text, projectId: selected.id }),
      }));
      const time = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      setMessages((current) => ({
        ...current,
        [selected.id]: [
          ...(current[selected.id] ?? []),
          { id: crypto.randomUUID(), role: "owner", author: "You", time, body: text },
          { id: crypto.randomUUID(), role: "agent", author: "ReDDone", time, body: result.reply },
        ],
      }));
      setDraft("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The clarification could not be sent.");
    } finally {
      setSending(false);
    }
  }

  if (!loading && projects.length === 0) {
    return <EmptyState icon="chat" title="No project threads" description={error || "Create a project before starting a clarification thread."} action={<ButtonLink href="/projects/new" icon="plus">New project</ButtonLink>} />;
  }

  return (
    <div className="chat-layout">
      <aside className="thread-list">
        <div className="thread-list-head"><span className="nav-label">Project threads</span><Link aria-label="Create a project" href="/projects/new"><Icon name="plus" size={18} /></Link></div>
        {loading && <div className="thread-item"><div><strong>Loading projects…</strong><small>Reading canonical state</small></div></div>}
        {projects.map((project) => <button className={`thread-item ${project.id === selectedId ? "is-active" : ""}`} key={project.id} onClick={() => { setSelectedId(project.id); setError(""); }}><span className="thread-project-mark">{project.name.split(/\s+/).map((word) => word[0]).join("").slice(0, 2).toUpperCase()}</span><div><strong>{project.name}</strong><small>{project.nextAction}</small></div></button>)}
        <div className="chat-boundary-note"><Icon name="lock" size={18} /><p><strong>Clarifications only</strong><small>Messages remain in this browser session. Credentials belong in write-only Connections.</small></p></div>
      </aside>

      <section className="chat-thread">
        <header className="chat-thread-head"><div><span className="project-monogram small-monogram">{selected ? selected.name.slice(0, 2).toUpperCase() : "…"}</span><span><strong>{selected?.name ?? "Loading project"}</strong><small>Session-only clarification thread</small></span></div><StatusBadge tone={selected?.status.includes("approval") ? "warning" : "info"}>{selected?.status.replaceAll("_", " ") ?? "loading"}</StatusBadge></header>
        <div className="message-list" aria-live="polite">
          <div className="chat-day"><span>This session</span></div>
          {selectedMessages.length === 0 && <div className="message message-agent"><span className="message-avatar">RO</span><div><header><strong>ReDDone</strong><time>Now</time></header><p>Ask about this project’s evidence, specification, build, or release state. Chat cannot approve actions, grant secrets, or change production.</p></div></div>}
          {selectedMessages.map((message) => <article className={`message message-${message.role}`} key={message.id}><span className="message-avatar">{message.role === "owner" ? "YO" : "RO"}</span><div><header><strong>{message.author}</strong><time>{message.time}</time></header><p>{message.body}</p>{message.role === "agent" && <Link href="/approvals">Open approvals <Icon name="arrow-right" size={15} /></Link>}</div></article>)}
        </div>
        <form className="composer" onSubmit={submit}>
          {error && <div className="secret-rejection" role="alert"><Icon name="shield" size={19} /><span><strong>Message not persisted</strong><p>{error}</p></span><Link href="/connections">Open Connections</Link></div>}
          <label><span className="sr-only">Send a project clarification</span><textarea disabled={!selected || sending} rows={3} placeholder="Clarify scope, audience, tone, or acceptance criteria…" value={draft} onChange={(event) => { setDraft(event.target.value); setError(""); }} onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key === "Enter") event.currentTarget.form?.requestSubmit(); }} /><div className="composer-tools"><span><Icon name="shield" size={15} />Secret-like text is blocked</span><span>⌘ ↵ to send</span><Button kind="primary" icon="arrow-up-right" disabled={!selected || sending} type="submit">{sending ? "Sending…" : "Send"}</Button></div></label>
        </form>
      </section>

      <aside className="chat-context">
        <span className="nav-label">Trusted context</span>
        {selected && <><div className="context-card"><span><Icon name="file" size={18} /></span><div><small>ProductSpec</small><strong>Canonical project state</strong><Link href={`/projects/${selected.id}/spec`}>Open specification</Link></div></div><div className="context-card"><span><Icon name="layers" size={18} /></span><div><small>Builds</small><strong>Verifier records</strong><Link href={`/projects/${selected.id}/builds`}>Open builds</Link></div></div><div className="context-card"><span><Icon name="approval" size={18} /></span><div><small>Next action</small><strong>{selected.nextAction}</strong><Link href="/approvals">Review approvals</Link></div></div></>}
        <div className="context-guard"><Icon name="warning" size={18} /><p>Chat can clarify intent. It cannot approve actions, grant secrets, or change provider accounts.</p></div>
      </aside>
    </div>
  );
}
