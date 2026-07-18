"use client";

import Link from "next/link";
import { useMemo, useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { Icon } from "@/components/icons";
import { Button, EmptyState, StatusBadge } from "@/components/ui";
import { detectSecretLikeInput } from "@/policy/secret-guard";
import { useProjectQuery } from "@/features/projects/project-queries";

import {
  conversationQueryKeys,
  useCancelTurnMutation,
  useConversationDetailQuery,
  useConversationListQuery,
  useCreateConversationMutation,
  useCreateTurnMutation,
} from "./conversation-queries";
import { useConversationActionMutation } from "./conversation-action-mutations";
import { useTurnStream } from "./use-turn-stream";

function displayTime(value: string) {
  return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function ProjectConversationWorkspace({ projectId }: { projectId: string }) {
  const project = useProjectQuery(projectId);
  const conversations = useConversationListQuery(projectId);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const [streamUrl, setStreamUrl] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const projectVersion = project.data?.optimisticVersion ?? null;
  const createConversation = useCreateConversationMutation(projectId, projectVersion);
  const activeConversationId = selectedId ?? conversations.data?.items[0]?.id ?? null;
  const detail = useConversationDetailQuery(projectId, activeConversationId);
  const createTurn = useCreateTurnMutation(projectId, activeConversationId, projectVersion);
  const cancelTurn = useCancelTurnMutation(projectId, activeConversationId, projectVersion);
  const executeAction = useConversationActionMutation({ projectId, conversationId: activeConversationId, projectVersion, operation: "execute" });
  const dismissAction = useConversationActionMutation({ projectId, conversationId: activeConversationId, projectVersion, operation: "dismiss" });
  const activeTurn = detail.data?.activeTurn ?? null;
  const stream = useTurnStream(streamUrl ?? activeTurn?.streamUrl ?? null, () => {
    void queryClient.invalidateQueries({ queryKey: conversationQueryKeys.detail(projectId, activeConversationId ?? "none") });
    void queryClient.invalidateQueries({ queryKey: conversationQueryKeys.list(projectId) });
    setStreamUrl(null);
  });

  const isSending = createTurn.isPending || Boolean(activeTurn) || ["connecting", "streaming", "reconnecting"].includes(stream.status);
  const title = detail.data?.conversation.title ?? project.data?.name ?? "Project conversation";
  const messages = useMemo(() => detail.data?.messages ?? [], [detail.data]);

  async function createThread() {
    setError("");
    try {
      const count = conversations.data?.items.length ?? 0;
      const created = await createConversation.mutateAsync({ title: `Conversation ${count + 1}` });
      setSelectedId(created.id);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "A conversation could not be created.");
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    const message = draft.trim();
    if (!message || !activeConversationId || isSending) return;
    if (detectSecretLikeInput(message)) {
      setError("That looks like a credential. It was not stored. Add values through the write-only project secrets manager.");
      return;
    }
    setError("");
    try {
      const created = await createTurn.mutateAsync({ message });
      setDraft("");
      setStreamUrl(created.streamUrl);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The message could not be sent.");
    }
  }

  if (conversations.isLoading || project.isLoading) {
    return <div className="inline-notice" role="status">Loading durable project workspace…</div>;
  }
  if (conversations.isError) {
    return <div className="inline-error" role="alert">{conversations.error instanceof Error ? conversations.error.message : "Project conversations are unavailable."}</div>;
  }

  return (
    <div className="project-conversation-workspace chat-layout">
      <aside className="thread-list" aria-label="Project conversations">
        <div className="thread-list-head"><span className="nav-label">Conversations</span><Button aria-label="Create conversation" icon="plus" onClick={createThread} disabled={createConversation.isPending}>{createConversation.isPending ? "…" : "New"}</Button></div>
        {conversations.data?.items.map((conversation) => (
          <button className={`thread-item ${conversation.id === activeConversationId ? "is-active" : ""}`} key={conversation.id} onClick={() => { setSelectedId(conversation.id); setStreamUrl(null); setError(""); }} type="button">
            <span className="thread-project-mark">{conversation.title.slice(0, 2).toUpperCase()}</span>
            <div><strong>{conversation.title}</strong><small>{conversation.activeTurn ? "Responding…" : "Durable project thread"}</small></div>
            {conversation.activeTurn && <StatusBadge tone="info" pulse>Live</StatusBadge>}
          </button>
        ))}
        {!conversations.data?.items.length && <EmptyState icon="chat" title="No conversations yet" description="Create a named, durable thread for this project." action={<Button icon="plus" onClick={createThread}>Start conversation</Button>} />}
        <div className="chat-boundary-note"><Icon name="lock" size={18} /><p><strong>Trusted boundaries</strong><small>Chat reads canonical state. It cannot reveal secrets, approve releases, or change providers.</small></p></div>
      </aside>

      <section className="chat-thread" aria-label={title}>
        <header className="chat-thread-head"><div><span className="project-monogram small-monogram">{title.slice(0, 2).toUpperCase()}</span><span><strong>{title}</strong><small>{activeTurn ? "Agent is responding" : "Project-scoped durable transcript"}</small></span></div><StatusBadge tone={activeTurn ? "info" : "neutral"} pulse={Boolean(activeTurn)}>{activeTurn ? activeTurn.status.replaceAll("_", " ") : "ready"}</StatusBadge></header>
        <div className="message-list" aria-live="polite">
          <div className="chat-day"><span>Conversation</span></div>
          {!activeConversationId && <EmptyState icon="chat" title="Select a conversation" description="Choose a thread or create a new project conversation." />}
          {activeConversationId && !messages.length && <div className="message message-agent"><span className="message-avatar">RO</span><div><header><strong>ReDDone</strong><time>Now</time></header><p>Ask about canonical evidence, the ProductSpec, runs, approvals, or the next safe action. Secret-like content is blocked before it is stored.</p></div></div>}
          {messages.map((message) => <article className={`message message-${message.role === "owner" ? "owner" : "agent"}`} key={message.id}><span className="message-avatar">{message.role === "owner" ? "YO" : "RO"}</span><div><header><strong>{message.role === "owner" ? "You" : "ReDDone"}</strong><time>{displayTime(message.createdAt)}</time></header><p>{message.content}</p></div></article>)}
          {stream.partial && <article className="message message-agent"><span className="message-avatar">RO</span><div><header><strong>ReDDone</strong><time>Streaming</time></header><p>{stream.partial}</p></div></article>}
          {detail.data?.actions.map((action) => <article className="conversation-action-card" key={action.id}><div><span className="eyebrow">{action.risk} risk · expires {new Date(action.expiresAt).toLocaleTimeString()}</span><strong>{action.command.replace("project.", "Project ")}</strong><p>Expected project version {action.expectedProjectVersion}. This typed command is revalidated before execution.</p></div><div><Button kind="secondary" disabled={dismissAction.isPending || executeAction.isPending} onClick={() => dismissAction.mutate(action.id)}>Dismiss</Button><Button kind="primary" disabled={dismissAction.isPending || executeAction.isPending} onClick={() => executeAction.mutate(action.id)}>Apply</Button></div></article>)}
        </div>
        <form className="composer" onSubmit={submit}>
          {error && <div className="secret-rejection" role="alert"><Icon name="shield" size={19} /><span><strong>Message not persisted</strong><p>{error}</p></span><Link href={`/projects/${projectId}/settings`}>Open project secrets</Link></div>}
          <label><span className="sr-only">Send a project message</span><textarea disabled={!activeConversationId || isSending} rows={3} placeholder="Ask about this project’s canonical state…" value={draft} onPaste={(event) => { const text = event.clipboardData.getData("text"); if (detectSecretLikeInput(text)) { event.preventDefault(); setError("Credential-like paste was blocked before it entered this conversation."); } }} onDrop={(event) => { const text = event.dataTransfer.getData("text"); if (detectSecretLikeInput(text)) { event.preventDefault(); setError("Credential-like content was blocked before it entered this conversation."); } }} onChange={(event) => { const next = event.target.value; if (detectSecretLikeInput(next)) { setError("Credential-like text was blocked before it entered this conversation."); return; } setDraft(next); setError(""); }} onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key === "Enter") event.currentTarget.form?.requestSubmit(); }} />
            <div className="composer-tools"><span><Icon name="shield" size={15} />Credentials are blocked before storage</span><span>⌘ ↵ to send</span>{activeTurn ? <Button kind="danger" type="button" onClick={() => cancelTurn.mutate(activeTurn.id)} disabled={cancelTurn.isPending}>Stop</Button> : <Button kind="primary" icon="arrow-up-right" disabled={!activeConversationId || !draft.trim() || isSending} type="submit">Send</Button>}</div>
          </label>
        </form>
      </section>

      <aside className="chat-context" aria-label="Project context">
        <span className="nav-label">Canonical context</span>
        <div className="context-card"><span><Icon name="activity" size={18} /></span><div><small>Lifecycle</small><strong>{project.data?.status.replaceAll("_", " ") ?? "Loading"}</strong><Link href={`/projects/${projectId}/overview`}>Open overview</Link></div></div>
        <div className="context-card"><span><Icon name="approval" size={18} /></span><div><small>Pending approvals</small><strong>{project.data?.pendingApproval ? "Review required" : "None pending"}</strong><Link href="/approvals">Open approvals</Link></div></div>
        <div className="context-card"><span><Icon name="terminal" size={18} /></span><div><small>Latest workflow</small><strong>{project.data?.runs[0]?.status ?? "No runs"}</strong><Link href={`/projects/${projectId}/builds`}>Open builds</Link></div></div>
        <div className="context-guard"><Icon name="warning" size={18} /><p>Secrets stay write-only and approvals stay in their dedicated flow. Chat remains a bounded control surface.</p></div>
      </aside>
    </div>
  );
}
