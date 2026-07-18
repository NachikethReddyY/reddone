"use client";

import { useEffect, useRef, useState } from "react";

import { ConversationEventSchema } from "@/contracts";

type StreamState = { status: "idle" | "connecting" | "streaming" | "reconnecting" | "completed" | "failed"; partial: string; lastEventId: string | null };

export function useTurnStream(streamUrl: string | null, onTerminal: () => void) {
  const [state, setState] = useState<StreamState>({ status: "idle", partial: "", lastEventId: null });
  const onTerminalRef = useRef(onTerminal);

  useEffect(() => {
    onTerminalRef.current = onTerminal;
  }, [onTerminal]);

  useEffect(() => {
    if (!streamUrl) return;
    let source: EventSource | null = null;
    let disposed = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let attempts = 0;
    const seen = new Set<string>();
    let partial = "";
    let lastEventId: string | null = null;

    const connect = () => {
      if (disposed) return;
      const url = lastEventId ? `${streamUrl}${streamUrl.includes("?") ? "&" : "?"}cursor=${encodeURIComponent(lastEventId)}` : streamUrl;
      setState((current) => ({ ...current, status: attempts ? "reconnecting" : "connecting" }));
      source = new EventSource(url, { withCredentials: true });
      source.onopen = () => setState((current) => ({ ...current, status: "streaming" }));
      const handle = (event: MessageEvent<string>) => {
        const parsed = ConversationEventSchema.safeParse({
          id: event.lastEventId,
          type: event.type,
          payload: JSON.parse(event.data),
          createdAt: new Date().toISOString(),
        });
        if (!parsed.success || seen.has(parsed.data.id)) return;
        seen.add(parsed.data.id);
        lastEventId = parsed.data.id;
        if (parsed.data.type === "assistant.delta") partial += parsed.data.payload.delta ?? "";
        const terminal = ["turn.completed", "turn.failed", "turn.canceled"].includes(parsed.data.type);
        setState({ status: terminal ? (parsed.data.type === "turn.completed" ? "completed" : "failed") : "streaming", partial, lastEventId });
        if (terminal) {
          source?.close();
          onTerminalRef.current();
        }
      };
      for (const eventType of ["turn.started", "agent.status", "tool.started", "tool.completed", "assistant.delta", "action.proposed", "assistant.completed", "turn.failed", "turn.canceled", "turn.completed"] as const) {
        source.addEventListener(eventType, handle as EventListener);
      }
      source.onerror = () => {
        source?.close();
        if (disposed) return;
        attempts += 1;
        reconnectTimer = setTimeout(connect, Math.min(1_000 * 2 ** Math.min(attempts, 4), 10_000));
      };
    };
    connect();
    return () => {
      disposed = true;
      source?.close();
      if (reconnectTimer) clearTimeout(reconnectTimer);
    };
  }, [streamUrl]);

  return streamUrl ? state : { status: "idle" as const, partial: "", lastEventId: null };
}
