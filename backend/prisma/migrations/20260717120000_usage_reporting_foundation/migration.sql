-- Promote provider model and pricing snapshots to first-class usage fields.
-- Historical cost_micros is intentionally left unchanged.
ALTER TABLE "usage_ledger"
  ADD COLUMN "model" VARCHAR(120),
  ADD COLUMN "inputRateMicrosPerMillion" BIGINT,
  ADD COLUMN "outputRateMicrosPerMillion" BIGINT,
  ADD COLUMN "pricingVersion" VARCHAR(100);

UPDATE "usage_ledger"
SET "model" = COALESCE(LEFT(NULLIF(BTRIM("metadata"->>'model'), ''), 120), 'unknown')
WHERE "model" IS NULL;

ALTER TABLE "usage_ledger"
  ALTER COLUMN "model" SET NOT NULL;

CREATE INDEX "usage_ledger_workspaceId_operation_occurredAt_idx"
  ON "usage_ledger"("workspaceId", "operation", "occurredAt");

CREATE INDEX "usage_ledger_workspaceId_model_occurredAt_idx"
  ON "usage_ledger"("workspaceId", "model", "occurredAt");
