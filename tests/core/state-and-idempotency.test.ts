import { describe, expect, it } from "vitest";

import {
  assertApprovalTransition,
  assertOptimisticVersion,
  assertRunTransition,
  decideDueSchedule,
  deriveIdempotencyKey,
  InMemoryIdempotencyStore,
  parseIfMatch,
  requestFingerprint,
} from "@/server";

describe("state and replay safety", () => {
  it("coalesces concurrent duplicate work", async () => {
    const store = new InMemoryIdempotencyStore();
    const key = "build:request-123";
    const fingerprint = requestFingerprint("POST", "/api/v1/projects/p1/runs", { kind: "build" });
    let calls = 0;
    const operation = async () => {
      calls += 1;
      await Promise.resolve();
      return { runId: "run-1" };
    };

    const [first, second] = await Promise.all([
      store.execute(key, fingerprint, operation),
      store.execute(key, fingerprint, operation),
    ]);
    expect(calls).toBe(1);
    expect(first.value).toEqual(second.value);
    expect([first.replayed, second.replayed].filter(Boolean)).toHaveLength(1);
  });

  it("rejects reuse of an idempotency key for different input", async () => {
    const store = new InMemoryIdempotencyStore();
    await store.execute("release:request-123", "fingerprint-a", () => "ok");
    await expect(store.execute("release:request-123", "fingerprint-b", () => "wrong")).rejects.toThrow(
      /different request/i,
    );
    expect(deriveIdempotencyKey("vercel.deploy", ["project-1", "artifact-hash"])).toMatch(
      /^vercel\.deploy:[a-f0-9]{64}$/,
    );
  });

  it("enforces state transitions and optimistic preconditions", () => {
    expect(() => assertRunTransition("queued", "running")).not.toThrow();
    expect(() => assertRunTransition("succeeded", "running")).toThrow(/Invalid run transition/);
    expect(() => assertApprovalTransition("approved", "consumed")).not.toThrow();
    expect(() => assertApprovalTransition("consumed", "approved")).toThrow();
    expect(parseIfMatch('W/"7"')).toBe(7);
    expect(() => assertOptimisticVersion(6, 7)).toThrow(/changed/i);
  });

  it("coalesces missed schedule intervals instead of creating a catch-up storm", () => {
    const now = new Date("2026-07-11T12:00:00.000Z");
    const decision = decideDueSchedule(
      {
        kind: "hourly_research",
        enabled: true,
        nextRunAt: new Date("2026-07-11T03:00:00.000Z"),
        consecutiveFailures: 0,
        backoffUntil: null,
      },
      now,
    );
    expect(decision.enqueue).toBe(true);
    expect(decision.scheduledFor?.toISOString()).toBe("2026-07-11T03:00:00.000Z");
    expect(decision.nextRunAt?.toISOString()).toBe("2026-07-11T13:00:00.000Z");
  });
});

