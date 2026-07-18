import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  assertSameOrigin,
  HttpError,
  parseMutationExpectedVersion,
  parseMutationIdempotencyKey,
} from "@/workflows/http";
import {
  getConnection,
  resetDemoStore,
  updateConnectionMetadata,
} from "@/workflows/demo-store";

afterEach(() => vi.unstubAllEnvs());

describe("REST mutation preconditions", () => {
  it("accepts only canonical idempotency keys and integer If-Match versions", () => {
    expect(parseMutationIdempotencyKey("run-retry:request_123")).toBe("run-retry:request_123");
    expect(() => parseMutationIdempotencyKey("short")).toThrow(HttpError);
    expect(() => parseMutationIdempotencyKey("request key with spaces")).toThrow(HttpError);

    expect(parseMutationExpectedVersion('W/"7"', true)).toBe(7);
    expect(parseMutationExpectedVersion("0", true)).toBe(0);
    expect(parseMutationExpectedVersion(null, false)).toBeNull();
    for (const invalid of [null, "", '""', "1.2", "-1", "1, 2", "01"]) {
      expect(() => parseMutationExpectedVersion(invalid, true)).toThrow(HttpError);
    }
  });

  it("rejects absent, malformed, and cross-site origins in live mode", () => {
    vi.stubEnv("APP_MODE", "private");
    vi.stubEnv("DEMO_MODE", "true");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://console.example.test");

    expect(() => assertSameOrigin(new Request("https://console.example.test/api/v1/chat", {
      method: "POST",
      headers: { origin: "https://console.example.test", "sec-fetch-site": "same-origin" },
    }))).not.toThrow();
    expect(() => assertSameOrigin(new Request("https://console.example.test/api/v1/chat", { method: "POST" }))).toThrow(/origin/i);
    expect(() => assertSameOrigin(new Request("https://console.example.test/api/v1/chat", {
      method: "POST",
      headers: { origin: "https://attacker.example", "sec-fetch-site": "cross-site" },
    }))).toThrow(/cross-origin/i);
  });

  it("increments demo connection versions and rejects stale writes", () => {
    resetDemoStore();
    const before = getConnection("kimi");
    expect(before?.optimisticVersion).toBe(0);
    const updated = updateConnectionMetadata("kimi", { status: "untested" }, 0);
    expect(updated.optimisticVersion).toBe(1);
    expect(() => updateConnectionMetadata("kimi", { status: "healthy" }, 0)).toThrow(/version conflict/i);
  });
});

describe("versioned production route coverage", () => {
  const files = [
    "src/app/api/v1/projects/[projectId]/runs/route.ts",
    "src/app/api/v1/projects/[projectId]/research-imports/route.ts",
    "src/app/api/v1/runs/[runId]/cancel/route.ts",
    "src/app/api/v1/runs/[runId]/retry/route.ts",
    "src/app/api/v1/connections/[provider]/route.ts",
    "src/app/api/v1/connections/[provider]/test/route.ts",
  ];

  it.each(files)("requires If-Match in %s", (file) => {
    const source = readFileSync(resolve(process.cwd(), file), "utf8");
    expect(source).toContain("{ requireVersion: true }");
  });

  it("persists a provider connection version fence in schema and migration", () => {
    const schema = readFileSync(resolve(process.cwd(), "prisma/schema.prisma"), "utf8");
    const migration = readFileSync(
      resolve(process.cwd(), "prisma/migrations/20260711170000_mutation_version_fences/migration.sql"),
      "utf8",
    );
    const connection = schema.match(/model ProviderConnection \{[\s\S]*?\n\}/)?.[0] ?? "";
    expect(connection).toContain("optimisticVersion");
    expect(migration).toContain('ALTER TABLE "provider_connections"');
    expect(migration).toContain('"optimisticVersion"');
  });

  it("commits provider test state and its published receipt in one transaction", () => {
    const vault = readFileSync(resolve(process.cwd(), "src/server/secret-vault.ts"), "utf8");
    const route = readFileSync(
      resolve(process.cwd(), "src/app/api/v1/connections/[provider]/test/route.ts"),
      "utf8",
    );
    expect(vault).toContain("completePublishedIdempotencyReceiptInTransaction(tx");
    expect(route).toContain("idempotencyCompletion:");
    expect(route).not.toContain("connectionUpdateCompleted");
  });
});
