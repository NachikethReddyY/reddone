import { GenerateFindingSpecInputSchema } from "@/contracts";
import { isDemoMode } from "@/server/env";
import { readIdempotent, serializeDemoRun, startDemoSpecification, writeIdempotent } from "@/workflows/demo-store";
import { handleRouteError, HttpError, mutationContext, ok, requestId } from "@/workflows/http";
import { createSpecificationRun, dispatchProductionRun, serializeRun } from "@/workflows/production-run";

type Context = { params: Promise<{ projectId: string; findingId: string }> };

export async function POST(request: Request, { params }: Context) {
  const id = requestId(request);
  try {
    const context = await mutationContext(request, { requireVersion: true });
    const body = GenerateFindingSpecInputSchema.parse(await request.json());
    const { projectId, findingId } = await params;
    if (!isDemoMode()) {
      const created = await createSpecificationRun({
        workspaceId: context.owner.workspaceId,
        projectId,
        findingId,
        expectedProjectVersion: context.expectedVersion!,
        budgetCeilingMicros: body.budgetCeilingMicros,
        idempotencyKey: context.idempotencyKey,
      });
      const executorRunId = await dispatchProductionRun(context.owner.workspaceId, created.run.id);
      return ok(
        {
          ...serializeRun(created.run),
          findingId,
          executorRunId,
          dispatchStatus: executorRunId ? "dispatched" : "pending",
          replayed: created.replayed,
        },
        context.requestId,
        { status: 202 },
      );
    }
    const cached = readIdempotent<ReturnType<typeof serializeDemoRun> & { findingId: string }>(context.idempotencyKey);
    if (cached) {
      if (cached.projectId !== projectId || cached.findingId !== findingId) {
        throw new Error("The idempotency key was already used for different specification input.");
      }
      return ok({ ...cached, replayed: true }, context.requestId, { status: 202 });
    }
    const run = startDemoSpecification({ projectId, findingId, expectedProjectVersion: context.expectedVersion! });
    const result = { ...serializeDemoRun(run), findingId, replayed: false };
    writeIdempotent(context.idempotencyKey, result);
    return ok(result, context.requestId, { status: 202 });
  } catch (error) {
    if (error instanceof Error && /project version conflict/i.test(error.message)) {
      return handleRouteError(new HttpError("precondition_failed", "Project version conflict.", 412), id);
    }
    return handleRouteError(error, id);
  }
}
