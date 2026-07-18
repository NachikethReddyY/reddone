import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("Prisma persistence invariants", () => {
  const schema = readFileSync(resolve(process.cwd(), "prisma/schema.prisma"), "utf8");
  const migration = readFileSync(
    resolve(process.cwd(), "prisma/migrations/20260711000000_initial/migration.sql"),
    "utf8",
  );

  it("stores only encrypted secret envelope material", () => {
    const secretModel = schema.match(/model SecretVersion \{[\s\S]*?\n\}/)?.[0] ?? "";
    expect(secretModel).toContain("ciphertext");
    expect(secretModel).toContain("wrappedDataKey");
    expect(secretModel).toContain("contextHash");
    expect(secretModel).not.toMatch(/\bplaintext\b/i);
  });

  it("checks in database-level concurrency and authorization guards", () => {
    expect(migration).toContain('CREATE UNIQUE INDEX "one_active_build_per_project"');
    expect(migration).toContain('ADD CONSTRAINT "live_reddit_requires_authorization"');
    expect(migration).toContain('ADD CONSTRAINT "secret_scope_matches_project"');
    expect(migration).toContain('ADD CONSTRAINT "repositories_are_private"');
  });
});
