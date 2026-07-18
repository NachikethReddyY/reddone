CREATE TABLE "waitlist_entries" (
    "id" UUID NOT NULL,
    "email" VARCHAR(320) NOT NULL,
    "source" VARCHAR(80) NOT NULL DEFAULT 'beta-page',
    "requestCount" INTEGER NOT NULL DEFAULT 1,
    "consentedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastRequestedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "waitlist_entries_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "waitlist_entries_email_key" ON "waitlist_entries"("email");
CREATE INDEX "waitlist_entries_createdAt_idx" ON "waitlist_entries"("createdAt" DESC);
