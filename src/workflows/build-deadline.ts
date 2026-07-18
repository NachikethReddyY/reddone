import { IntegrationError } from "@/integrations/errors";

export const BUILD_WALL_CLOCK_LIMIT_MS = 30 * 60 * 1_000;

export class BuildDeadlineExceededError extends IntegrationError {
  constructor(readonly stage: string) {
    super("timeout", `The build exceeded its 30-minute wall-clock limit during ${stage}.`, false, 504);
    this.name = "BuildDeadlineExceededError";
  }
}

type DeadlineOperationOptions<T> = {
  /**
   * Resource-producing calls can settle after their caller has timed out. This hook
   * destroys a late resource instead of allowing it to escape the build boundary.
   */
  onLateResolve?: (value: T) => void | Promise<void>;
};

/** A monotonic, non-extendable deadline shared by the entire two-sandbox build. */
export class BuildDeadline {
  readonly deadlineAt: number;

  constructor(input: { startedAt?: number; deadlineAt?: number } = {}) {
    const startedAt = input.startedAt ?? Date.now();
    const policyDeadline = startedAt + BUILD_WALL_CLOCK_LIMIT_MS;
    this.deadlineAt = Math.min(input.deadlineAt ?? policyDeadline, policyDeadline);
  }

  assertRemaining(stage: string, now = Date.now()) {
    if (now >= this.deadlineAt) throw new BuildDeadlineExceededError(stage);
  }

  remainingMs(stage: string, maximumMs = Number.POSITIVE_INFINITY, now = Date.now()) {
    this.assertRemaining(stage, now);
    return Math.max(1, Math.min(maximumMs, this.deadlineAt - now));
  }

  async run<T>(
    stage: string,
    operation: (signal: AbortSignal) => Promise<T>,
    options: DeadlineOperationOptions<T> = {},
  ): Promise<T> {
    this.assertRemaining(stage);
    const controller = new AbortController();
    const timeoutMs = this.remainingMs(stage);
    let timedOut = false;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

    const operationPromise = operation(controller.signal);
    if (options.onLateResolve) {
      void operationPromise
        .then(async (value) => {
          if (timedOut) await options.onLateResolve?.(value);
        })
        .catch(() => undefined);
    }

    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        reject(new BuildDeadlineExceededError(stage));
        controller.abort();
      }, timeoutMs);
      timeoutHandle.unref?.();
    });

    try {
      const result = await Promise.race([operationPromise, timeoutPromise]);
      try {
        this.assertRemaining(stage);
      } catch (error) {
        timedOut = true;
        controller.abort();
        await options.onLateResolve?.(result);
        throw error;
      }
      return result;
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }
  }
}

export function isBuildDeadlineExceeded(error: unknown): error is BuildDeadlineExceededError {
  return error instanceof BuildDeadlineExceededError;
}
