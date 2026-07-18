import { executeConversationTurnStep } from "./conversation-agent-steps";

/** Durable bounded turn executor. It intentionally uses no generic tools while read-only tooling is gated. */
export async function executeConversationTurn(workspaceId: string, turnId: string) {
  "use workflow";
  return executeConversationTurnStep(workspaceId, turnId);
}
