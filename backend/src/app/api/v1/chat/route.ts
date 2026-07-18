import { z } from "zod";

import { assertNoSecretLikeInput } from "@/policy/secret-guard";
import { createConversationTurn, createProjectConversation, listProjectConversations } from "@/server/conversation-repository";
import { isDemoMode } from "@/server/env";
import { getProject } from "@/workflows/demo-store";
import { dispatchConversationTurn } from "@/workflows/conversation-dispatch";
import { handleRouteError, HttpError, mutationContext, ok, requestId } from "@/workflows/http";

const LegacyChatInputSchema = z.object({ message: z.string().trim().min(1).max(4_000), projectId: z.string().optional() }).strict();

/** Compatibility adapter retained for one release; new clients use project conversation routes. */
export async function POST(request: Request) {
  const id = requestId(request);
  try {
    const context = await mutationContext(request, { requireVersion: false });
    const body = LegacyChatInputSchema.parse(await request.json());
    assertNoSecretLikeInput(body.message);
    if (!body.projectId) throw new HttpError("bad_request", "Project-scoped chat requires a projectId.", 400);
    if (context.expectedVersion === null) {
      throw new HttpError("precondition_required", "An If-Match project version is required for project-scoped chat.", 428);
    }
    if (isDemoMode()) {
      const project = getProject(body.projectId);
      if (!project) throw new HttpError("not_found", "Project not found.", 404);
      if (project.version !== context.expectedVersion) throw new HttpError("precondition_failed", "Project version conflict.", 412);
      return ok({ reply: "Demo chat is session-only. Deploy durable conversations to persist this request.", persisted: false, storage: "session_only", migration: "project_conversation_required" }, context.requestId);
    }
    const threads = await listProjectConversations({ workspaceId: context.owner.workspaceId, projectId: body.projectId });
    const conversation = threads.find((thread) => !thread.archivedAt) ?? await createProjectConversation({
      workspaceId: context.owner.workspaceId,
      projectId: body.projectId,
      title: "Default conversation",
    });
    const created = await createConversationTurn({
      workspaceId: context.owner.workspaceId,
      projectId: body.projectId,
      conversationId: conversation.id,
      ownerUserId: context.owner.userId,
      message: body.message,
      idempotencyKey: context.idempotencyKey,
      expectedProjectVersion: context.expectedVersion,
    });
    const executorRunId = created.replayed ? null : await dispatchConversationTurn(context.owner.workspaceId, created.turn.id);
    return ok({
      reply: "Your message was queued in the project conversation.",
      persisted: true,
      storage: "project_conversation",
      conversationId: conversation.id,
      turnId: created.turn.id,
      streamUrl: new URL(`/api/v1/projects/${body.projectId}/conversation/${conversation.id}/turns/${created.turn.id}/events`, request.url).toString(),
      dispatchStatus: executorRunId ? "dispatched" : "pending",
      migration: "use_project_conversation_api",
    }, context.requestId, { status: 202 });
  } catch (error) {
    return handleRouteError(error, id);
  }
}
