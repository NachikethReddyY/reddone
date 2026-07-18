import { SelectFindingInputSchema } from "@/contracts";
import { isDemoMode } from "@/server/env";
import { selectProjectFinding } from "@/server/finding-selection";
import { readIdempotent, selectDemoFinding, writeIdempotent } from "@/workflows/demo-store";
import { handleRouteError, HttpError, mutationContext, ok, requestId } from "@/workflows/http";

type Context = { params: Promise<{ projectId: string; findingId: string }> };

export async function POST(request: Request, { params }: Context) {
  const id = requestId(request);
  try {
    const context = await mutationContext(request, { requireVersion: true });
    SelectFindingInputSchema.parse(await request.json());
    const { projectId, findingId } = await params;
    if (!isDemoMode()) {
      const result = await selectProjectFinding({
        workspaceId: context.owner.workspaceId,
        projectId,
        findingId,
        expectedProjectVersion: context.expectedVersion!,
        idempotencyKey: context.idempotencyKey,
        actorUserId: context.owner.userId,
        requestId: context.requestId,
      });
      return ok(result, context.requestId);
    }
    const cached = readIdempotent<ReturnType<typeof selectDemoFinding>>(context.idempotencyKey);
    if (cached) {
      if (cached.projectId !== projectId || cached.findingId !== findingId) {
        throw new Error("The idempotency key was already used for a different finding selection.");
      }
      return ok({ ...cached, replayed: true }, context.requestId);
    }
    const result = selectDemoFinding({ projectId, findingId, expectedProjectVersion: context.expectedVersion! });
    writeIdempotent(context.idempotencyKey, result);
    return ok(result, context.requestId);
  } catch (error) {
    if (error instanceof Error && /project version conflict/i.test(error.message)) {
      return handleRouteError(new HttpError("precondition_failed", "Project version conflict.", 412), id);
    }
    return handleRouteError(error, id);
  }
}
