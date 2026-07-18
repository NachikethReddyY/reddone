import { listConversationEvents, serializeSseEvent } from "@/server/conversation-events";
import { isDemoMode } from "@/server/env";
import { assertOwnerRequest, HttpError } from "@/workflows/http";

type Context = { params: Promise<{ projectId: string; conversationId: string; turnId: string }> };

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function parseCursor(value: string | null) {
  if (!value) return 0n;
  if (!/^\d{1,20}$/.test(value)) throw new HttpError("bad_request", "Event cursor is invalid.", 400);
  return BigInt(value);
}

export async function GET(request: Request, { params }: Context) {
  if (isDemoMode()) return new Response("Durable conversations are unavailable in demo mode.", { status: 503 });
  const owner = await assertOwnerRequest(request);
  const { projectId, conversationId, turnId } = await params;
  const url = new URL(request.url);
  const initialCursor = parseCursor(request.headers.get("last-event-id") ?? url.searchParams.get("cursor"));
  const encoder = new TextEncoder();
  let cursor = initialCursor;
  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const close = () => {
        if (closed) return;
        closed = true;
        controller.close();
      };
      const send = async () => {
        try {
          const events = await listConversationEvents({ workspaceId: owner.workspaceId, projectId, conversationId, turnId, cursor, limit: 100 });
          for (const event of events) {
            cursor = BigInt(event.id);
            controller.enqueue(encoder.encode(serializeSseEvent(event)));
          }
        } catch {
          controller.enqueue(encoder.encode("event: turn.failed\ndata: {\"message\":\"The event stream ended safely. Reconnect to replay persisted events.\"}\n\n"));
          close();
        }
      };
      await send();
      const heartbeat = setInterval(() => {
        if (!closed) controller.enqueue(encoder.encode(": keepalive\n\n"));
      }, 15_000);
      const poll = setInterval(() => { void send(); }, 1_500);
      const timeout = setTimeout(() => {
        clearInterval(heartbeat);
        clearInterval(poll);
        close();
      }, 55_000);
      request.signal.addEventListener("abort", () => {
        clearInterval(heartbeat);
        clearInterval(poll);
        clearTimeout(timeout);
        close();
      }, { once: true });
    },
    cancel() {
      closed = true;
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}
