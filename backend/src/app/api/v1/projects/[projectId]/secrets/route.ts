import { z } from "zod";

import { assertProjectRuntimeSecretNameAllowed, maskedSuffix } from "@/policy/secret-guard";
import { isDemoMode } from "@/server/env";
import {
  getLatestGrantableArtifactMetadata,
  listProjectSecretMetadata,
  saveProjectSecret,
} from "@/server/secret-vault";
import { getProject, readIdempotent, writeIdempotent } from "@/workflows/demo-store";
import {
  assertOwnerRequest,
  handleRouteError,
  HttpError,
  mutationContext,
  ok,
  requestId,
  route,
} from "@/workflows/http";

type Context = { params: Promise<{ projectId: string }> };

export async function GET(request: Request, { params }: Context) {
  const { projectId } = await params;
  return route(request, async () => {
    if (!isDemoMode()) {
      const owner = await assertOwnerRequest(request);
      const [metadata, grantTarget] = await Promise.all([
        listProjectSecretMetadata({ workspaceId: owner.workspaceId, projectId }),
        getLatestGrantableArtifactMetadata({ workspaceId: owner.workspaceId, projectId }),
      ]);
      return { mode: "live", ...metadata, grantTarget };
    }
    const project = getProject(projectId);
    if (!project) throw new HttpError("not_found", "Project not found.", 404);
    return {
      mode: "demo",
      projectOptimisticVersion: project.version,
      items: [],
      grantTarget: null,
      message: "Demo mode never persists project secret values or grants.",
    };
  });
}

export async function POST(request: Request, { params }: Context) {
  const id = requestId(request);
  try {
    const context = await mutationContext(request, { requireVersion: true });
    const { projectId } = await params;
    const body = z
      .object({
        name: z.string().trim().regex(/^[A-Z][A-Z0-9_]{1,99}$/),
        value: z.string().min(8).max(16_384),
        purpose: z.string().trim().min(2).max(200),
      })
      .strict()
      .parse(await request.json());
    assertProjectRuntimeSecretNameAllowed(body.name);
    if (!isDemoMode()) {
      const record = await saveProjectSecret({
        workspaceId: context.owner.workspaceId,
        projectId,
        name: body.name,
        value: body.value,
        createdByUserId: context.owner.userId,
        idempotencyKey: context.idempotencyKey,
        expectedProjectVersion: context.expectedVersion!,
        purpose: body.purpose,
        requestId: context.requestId,
      });
      return ok({ mode: "live", ...record, status: "active" }, context.requestId, { status: record.replayed ? 200 : 201 });
    }
    const cached = readIdempotent<unknown>(context.idempotencyKey);
    if (cached) return ok(cached, context.requestId);
    const project = getProject(projectId);
    if (!project) throw new HttpError("not_found", "Project not found.", 404);
    if (project.version !== context.expectedVersion) throw new HttpError("precondition_failed", "Project version conflict.", 412);
    const record = {
      id: `demo-secret-${crypto.randomUUID()}`,
      mode: "demo",
      name: body.name,
      version: 1,
      maskedSuffix: maskedSuffix(body.value),
      purpose: body.purpose,
      status: "demo_discarded",
      message: "Demo mode discarded the supplied value immediately. No plaintext or ciphertext was persisted.",
    };
    writeIdempotent(context.idempotencyKey, record);
    return ok(record, context.requestId, { status: 201 });
  } catch (error) {
    return handleRouteError(error, id);
  }
}
