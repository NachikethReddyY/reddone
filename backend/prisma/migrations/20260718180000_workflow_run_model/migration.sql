ALTER TABLE "workflow_runs"
ADD COLUMN "model" VARCHAR(120) NOT NULL DEFAULT 'moonshotai/kimi-k2.7-code';
