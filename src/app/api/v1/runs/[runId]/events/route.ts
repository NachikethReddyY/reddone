import { getDb } from "@/server/db";
import { isDemoMode } from "@/server/env";
import { z } from "zod";
import { getRun, listEvents } from "@/workflows/demo-store";
import { assertOwnerRequest, HttpError, route } from "@/workflows/http";
import { serializeRunEventPage } from "@/workflows/run-serialization";

type Context = { params: Promise<{ runId: string }> };

const EventPageQuerySchema = z.object({
  cursor: z.string().regex(/^\d+$/).default("0"),
  limit: z.coerce.number().int().min(1).max(100).default(100),
}).strict();

export async function GET(request: Request, { params }: Context) {
  const { runId } = await params;
  return route<unknown>(request, async () => {
    if (!isDemoMode()) {
        const owner = await assertOwnerRequest(request);
        const url = new URL(request.url);
        const query = EventPageQuerySchema.parse({
          cursor: url.searchParams.get("cursor") ?? undefined,
          limit: url.searchParams.get("limit") ?? undefined,
        });
        const cursor = BigInt(query.cursor);
        if (cursor > BigInt(Number.MAX_SAFE_INTEGER)) throw new HttpError("bad_request", "Event cursor is outside the safe range.", 400);
        const limit = query.limit;
        const exists = await getDb().workflowRun.findFirst({ where: { id: runId, workspaceId: owner.workspaceId }, select: { id: true } });
        if (!exists) throw new HttpError("not_found", "Run not found.", 404);
        const events = await getDb().activityEvent.findMany({
          where: { workspaceId: owner.workspaceId, runId, sequence: { gt: cursor } },
          orderBy: { sequence: "asc" },
          take: limit + 1,
        });
        const items = events.slice(0, limit);
        return serializeRunEventPage({
          items: items.map((event) => ({
            id: event.id,
            runId: event.runId,
            projectId: event.projectId,
            sequence: event.sequence,
            type: event.type,
            severity: event.severity,
            message: event.message,
            data: event.data,
            createdAt: event.createdAt,
          })),
          nextCursor: items.at(-1)?.sequence.toString() ?? null,
          retentionStartsAt: new Date(Date.now() - 30 * 24 * 60 * 60_000),
        });
    }
    if (!getRun(runId)) throw new HttpError("not_found", "Run not found.", 404);
    const url = new URL(request.url);
    const query = EventPageQuerySchema.parse({
      cursor: url.searchParams.get("cursor") ?? undefined,
      limit: url.searchParams.get("limit") ?? undefined,
    });
    const cursor = Number(query.cursor);
    if (!Number.isSafeInteger(cursor)) throw new HttpError("bad_request", "Event cursor is outside the safe range.", 400);
    const page = listEvents(runId, cursor, query.limit);
    const run = getRun(runId)!;
    return serializeRunEventPage({
      items: page.items.map((event) => ({
        id: `${event.runId}:${event.id}`,
        runId: event.runId,
        projectId: run.projectId,
        sequence: event.id,
        type: event.type,
        severity: event.level,
        message: event.message,
        data: {},
        createdAt: event.createdAt,
      })),
      nextCursor: page.items.length ? String(page.nextCursor) : null,
      retentionStartsAt: new Date(Date.now() - 30 * 24 * 60 * 60_000),
    });
  });
}
