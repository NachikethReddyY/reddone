-- Conversation usage can be owned by exactly one workflow run or conversation turn.
ALTER TABLE "budget_reservations" DROP CONSTRAINT "budget_reservations_workspaceId_projectId_runId_fkey";
ALTER TABLE "usage_ledger" DROP CONSTRAINT "usage_ledger_workspaceId_projectId_runId_fkey";
ALTER TABLE "credit_reservations" DROP CONSTRAINT "credit_reservations_workspaceId_projectId_runId_fkey";

ALTER TABLE "budget_reservations" ALTER COLUMN "runId" DROP NOT NULL;
ALTER TABLE "usage_ledger" ALTER COLUMN "runId" DROP NOT NULL;
ALTER TABLE "credit_reservations" ALTER COLUMN "runId" DROP NOT NULL;

ALTER TABLE "budget_reservations" ADD COLUMN "turnId" UUID;
ALTER TABLE "usage_ledger" ADD COLUMN "turnId" UUID;
ALTER TABLE "credit_reservations" ADD COLUMN "turnId" UUID;

ALTER TABLE "budget_reservations"
  ADD CONSTRAINT "budget_reservations_workspace_project_run_fkey"
  FOREIGN KEY ("workspaceId", "projectId", "runId") REFERENCES "workflow_runs"("workspaceId", "projectId", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "budget_reservations_workspace_project_turn_fkey"
  FOREIGN KEY ("workspaceId", "projectId", "turnId") REFERENCES "conversation_turns"("workspaceId", "projectId", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "budget_reservations_one_owner" CHECK (("runId" IS NULL) <> ("turnId" IS NULL));

ALTER TABLE "usage_ledger"
  ADD CONSTRAINT "usage_ledger_workspace_project_run_fkey"
  FOREIGN KEY ("workspaceId", "projectId", "runId") REFERENCES "workflow_runs"("workspaceId", "projectId", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "usage_ledger_workspace_project_turn_fkey"
  FOREIGN KEY ("workspaceId", "projectId", "turnId") REFERENCES "conversation_turns"("workspaceId", "projectId", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "usage_ledger_one_owner" CHECK (("runId" IS NULL) <> ("turnId" IS NULL));

DROP INDEX "credit_reservations_runId_runAttempt_key";
ALTER TABLE "credit_reservations"
  ADD CONSTRAINT "credit_reservations_workspace_project_run_fkey"
  FOREIGN KEY ("workspaceId", "projectId", "runId") REFERENCES "workflow_runs"("workspaceId", "projectId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "credit_reservations_workspace_project_turn_fkey"
  FOREIGN KEY ("workspaceId", "projectId", "turnId") REFERENCES "conversation_turns"("workspaceId", "projectId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "credit_reservations_one_owner" CHECK (("runId" IS NULL) <> ("turnId" IS NULL));
CREATE UNIQUE INDEX "credit_reservations_runId_runAttempt_key" ON "credit_reservations"("runId", "runAttempt");
CREATE UNIQUE INDEX "credit_reservations_turnId_key" ON "credit_reservations"("turnId");
