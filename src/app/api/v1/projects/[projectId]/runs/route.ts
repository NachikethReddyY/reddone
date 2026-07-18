import { z } from "zod";

import { CreateRunInputSchema } from "@/contracts";
import { createProductionRun, dispatchProductionRun, serializeRun } from "@/workflows/production-run";
import { readIdempotent, serializeDemoRun, startRun, writeIdempotent } from "@/workflows/demo-store";
import { handleRouteError, mutationContext, ok, requestId } from "@/workflows/http";
import { isDemoMode } from "@/server/env";

type Context = { params: Promise<{ projectId: string }> };

export async function POST(request: Request, { params }: Context) {
  const id = requestId(request);
  try {
    const context = await mutationContext(request, { requireVersion: true });
    const { projectId } = await params;
    const rawBody: unknown = await request.json();
    if (!isDemoMode()) {
      const body = CreateRunInputSchema.parse(rawBody);
      const created = await createProductionRun({
        workspaceId: context.owner.workspaceId,
        projectId,
        kind: body.kind,
        ...(body.specVersionId ? { specVersionId: body.specVersionId } : {}),
        budgetCeilingMicros: body.budgetCeilingMicros,
        idempotencyKey: context.idempotencyKey,
        expectedProjectVersion: context.expectedVersion!,
      });
      const executorRunId = await dispatchProductionRun(context.owner.workspaceId, created.run.id);
      return ok({ ...serializeRun(created.run), executorRunId, dispatchStatus: executorRunId ? "dispatched" : "pending", replayed: created.replayed }, context.requestId, { status: 202 });
    }
    const cached = readIdempotent<unknown>(context.idempotencyKey);
    if (cached) return ok(cached, context.requestId);
    const body = z
      .object({ kind: z.enum(["research", "build", "polish"]), budgetCeilingMicros: z.number().int().nonnegative().optional(), specVersionId: z.string().optional() })
      .strict()
      .parse(rawBody);
    const run = startRun(projectId, body.kind, context.expectedVersion!);
    const serialized = serializeDemoRun(run);
    writeIdempotent(context.idempotencyKey, serialized);
    return ok(serialized, context.requestId, { status: 202 });
  } catch (error) {
    return handleRouteError(error, id);
  }
}
