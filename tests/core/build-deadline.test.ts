import { describe, expect, it, vi } from "vitest";

import {
  BUILD_WALL_CLOCK_LIMIT_MS,
  BuildDeadline,
  BuildDeadlineExceededError,
} from "@/workflows/build-deadline";

describe("two-sandbox build deadline", () => {
  it("cannot be extended beyond the 30-minute policy window", () => {
    const startedAt = 1_000;
    const deadline = new BuildDeadline({
      startedAt,
      deadlineAt: startedAt + BUILD_WALL_CLOCK_LIMIT_MS * 2,
    });

    expect(deadline.deadlineAt).toBe(startedAt + BUILD_WALL_CLOCK_LIMIT_MS);
  });

  it("caps provider timeouts to the remaining wall clock", () => {
    const deadline = new BuildDeadline({ startedAt: 1_000, deadlineAt: 11_000 });

    expect(deadline.remainingMs("provider call", 90_000, 4_000)).toBe(7_000);
    expect(deadline.remainingMs("provider call", 2_000, 4_000)).toBe(2_000);
  });

  it("fails before starting work after expiry", () => {
    const deadline = new BuildDeadline({ startedAt: 1_000, deadlineAt: 2_000 });

    expect(() => deadline.assertRemaining("verifier", 2_000)).toThrow(BuildDeadlineExceededError);
  });

  it("aborts an in-flight operation and cleans up a resource that resolves late", async () => {
    vi.useFakeTimers();
    try {
      const startedAt = Date.now();
      const deadline = new BuildDeadline({ startedAt, deadlineAt: startedAt + 10 });
      let resolveResource!: (value: { destroy: () => Promise<void> }) => void;
      const destroy = vi.fn(async () => undefined);
      const pending = new Promise<{ destroy: () => Promise<void> }>((resolve) => {
        resolveResource = resolve;
      });

      const result = deadline.run("sandbox creation", () => pending, {
        onLateResolve: (resource) => resource.destroy(),
      });
      const assertion = expect(result).rejects.toBeInstanceOf(BuildDeadlineExceededError);
      await vi.advanceTimersByTimeAsync(10);
      await assertion;

      resolveResource({ destroy });
      await vi.runAllTimersAsync();
      await Promise.resolve();
      expect(destroy).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});
