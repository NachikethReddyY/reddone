-- Provider connection settings are mutable resources and participate in the
-- same If-Match contract as projects, runs, specifications, and schedules.
ALTER TABLE "provider_connections"
ADD COLUMN "optimisticVersion" INTEGER NOT NULL DEFAULT 0;
