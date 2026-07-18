import { z } from "zod";

import { assertNoSecretLikeInput } from "@/policy/secret-guard";
import { getDb } from "@/server/db";
import { isDemoMode } from "@/server/env";
import { getProject } from "@/workflows/demo-store";
import { handleRouteError, HttpError, mutationContext, ok, requestId } from "@/workflows/http";

export async function POST(request: Request) {
  const id = requestId(request);
  try {
    const context = await mutationContext(request);
    const body = z.object({ message: z.string().trim().min(1).max(4_000), projectId: z.string().optional() }).strict().parse(await request.json());
    assertNoSecretLikeInput(body.message);
    if (body.projectId) {
      if (context.expectedVersion === null) {
        throw new HttpError("precondition_required", "An If-Match project version is required for project-scoped chat.", 428);
      }
      if (!isDemoMode()) {
        const project = await getDb().project.findUnique({
          where: { workspaceId_id: { workspaceId: context.owner.workspaceId, id: body.projectId } },
          select: { optimisticVersion: true },
        });
        if (!project) throw new HttpError("not_found", "Project not found.", 404);
        if (project.optimisticVersion !== context.expectedVersion) {
          throw new HttpError("precondition_failed", "Project version conflict.", 412);
        }
      } else {
        const project = getProject(body.projectId);
        if (!project) throw new HttpError("not_found", "Project not found.", 404);
        if (project.version !== context.expectedVersion) throw new HttpError("precondition_failed", "Project version conflict.", 412);
      }
    }
    return ok(
      {
        reply:
          "I can clarify evidence, specifications, builds, and releases. Provider credentials belong in Connections and production changes always require an approval.",
        persisted: false,
        storage: "session_only",
      },
      context.requestId,
    );
  } catch (error) {
    return handleRouteError(error, id);
  }
}
