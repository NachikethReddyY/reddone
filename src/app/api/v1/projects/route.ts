import { z } from "zod";

import { ProjectConfigSchema, ProjectCreateInputSchema } from "@/contracts";
import { getDb } from "@/server/db";
import { isDemoMode } from "@/server/env";
import { createWorkspaceProject, listWorkspaceProjects } from "@/server/project-repository";
import { createProject, listProjects, readIdempotent, writeIdempotent } from "@/workflows/demo-store";
import { handleRouteError, mutationContext, ok, requestId, route } from "@/workflows/http";

const createSchema = z
  .object({
    name: z.string().trim().min(2).max(120),
    marketLabel: z.string().trim().min(2).max(120).optional(),
    sourceMode: z.enum(["fixture", "import", "reddit"]).optional(),
    config: z
      .object({
        marketLabel: z.string().trim().min(2).max(120),
        researchMode: z.enum(["fixture", "authorized_import", "live_reddit"]),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export function GET(request: Request) {
  return route(request, async () => {
    if (isDemoMode()) {
      return {
        items: listProjects(),
        workspaceTimeZone: process.env.WORKSPACE_TIMEZONE ?? "Asia/Singapore",
        demoMode: true,
      };
    }
    const { assertOwnerRequest } = await import("@/workflows/http");
    const owner = await assertOwnerRequest(request);
    const [items, workspace] = await Promise.all([
      listWorkspaceProjects(owner.workspaceId),
      getDb().workspace.findUnique({ where: { id: owner.workspaceId }, select: { timeZone: true } }),
    ]);
    if (!workspace) throw new Error("Workspace not found.");
    return { items, workspaceTimeZone: workspace.timeZone, demoMode: false };
  });
}

export async function POST(request: Request) {
  const id = requestId(request);
  try {
    const context = await mutationContext(request);
    const cached = readIdempotent<ReturnType<typeof createProject>>(context.idempotencyKey);
    if (cached) return ok(cached, context.requestId, { status: 200 });
    const rawBody: unknown = await request.json();
    if (!isDemoMode()) {
      const input = ProjectCreateInputSchema.parse(rawBody);
      const project = await createWorkspaceProject(context.owner.workspaceId, input);
      return ok(project, context.requestId, { status: 201 });
    }
    const body = createSchema.parse(rawBody);
    const sourceMode =
      body.sourceMode ??
      (body.config?.researchMode === "authorized_import" ? "import" : body.config?.researchMode === "live_reddit" ? "reddit" : "fixture");
    const config = ProjectConfigSchema.parse(body.config ?? {
      marketLabel: body.marketLabel ?? body.name,
      researchContext: "Evidence-backed product research and constrained application delivery.",
      researchMode: sourceMode === "import" ? "authorized_import" : sourceMode === "reddit" ? "live_reddit" : "fixture",
      sourceLabels: sourceMode === "reddit" ? ["Authorization pending"] : [],
      maxDocumentsPerRun: 100,
      maxCostMicrosPerRun: 5_000_000,
      workspaceTimeZone: process.env.WORKSPACE_TIMEZONE ?? "Asia/Singapore",
      hourlyResearchEnabled: false,
      fiveHourPolishEnabled: false,
    });
    const project = createProject({ name: body.name, config });
    writeIdempotent(context.idempotencyKey, project);
    return ok(project, context.requestId, { status: 201 });
  } catch (error) {
    return handleRouteError(error, id);
  }
}
