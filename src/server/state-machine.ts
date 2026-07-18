import type { RunStatus } from "@/contracts";

import { AppError } from "./errors";

export type ApprovalState = "pending" | "approved" | "rejected" | "expired" | "consumed" | "superseded";
export type StepState = "pending" | "running" | "waiting" | "succeeded" | "failed" | "canceled" | "skipped";
export type DeploymentState =
  | "queued"
  | "uploading"
  | "ready_unpromoted"
  | "health_checking"
  | "healthy"
  | "failed"
  | "rolled_back"
  | "canceled";

const RUN_TRANSITIONS: Readonly<Record<RunStatus, readonly RunStatus[]>> = {
  queued: ["running", "cancel_requested", "canceled", "failed"],
  running: ["waiting_for_approval", "cancel_requested", "succeeded", "failed"],
  waiting_for_approval: ["running", "cancel_requested", "canceled", "failed"],
  cancel_requested: ["canceled", "failed"],
  canceled: [],
  succeeded: [],
  failed: [],
};

const STEP_TRANSITIONS: Readonly<Record<StepState, readonly StepState[]>> = {
  pending: ["running", "canceled", "skipped"],
  running: ["waiting", "succeeded", "failed", "canceled"],
  waiting: ["running", "failed", "canceled"],
  succeeded: [],
  failed: [],
  canceled: [],
  skipped: [],
};

const APPROVAL_TRANSITIONS: Readonly<Record<ApprovalState, readonly ApprovalState[]>> = {
  pending: ["approved", "rejected", "expired", "superseded"],
  approved: ["consumed", "expired", "superseded"],
  rejected: [],
  expired: [],
  consumed: [],
  superseded: [],
};

const DEPLOYMENT_TRANSITIONS: Readonly<Record<DeploymentState, readonly DeploymentState[]>> = {
  queued: ["uploading", "failed", "canceled"],
  uploading: ["ready_unpromoted", "failed", "canceled"],
  ready_unpromoted: ["health_checking", "failed", "canceled"],
  health_checking: ["healthy", "failed", "canceled"],
  healthy: ["rolled_back"],
  failed: [],
  rolled_back: [],
  canceled: [],
};

function assertTransition<State extends string>(
  subject: string,
  transitions: Readonly<Record<State, readonly State[]>>,
  from: State,
  to: State,
): void {
  if (from === to || !transitions[from].includes(to)) {
    throw new AppError("conflict", `Invalid ${subject} transition from ${from} to ${to}`, {
      safeDetails: { from, to },
    });
  }
}

export function assertRunTransition(from: RunStatus, to: RunStatus): void {
  assertTransition("run", RUN_TRANSITIONS, from, to);
}

export function assertStepTransition(from: StepState, to: StepState): void {
  assertTransition("workflow step", STEP_TRANSITIONS, from, to);
}

export function assertApprovalTransition(from: ApprovalState, to: ApprovalState): void {
  assertTransition("approval", APPROVAL_TRANSITIONS, from, to);
}

export function assertDeploymentTransition(from: DeploymentState, to: DeploymentState): void {
  assertTransition("deployment", DEPLOYMENT_TRANSITIONS, from, to);
}

export function assertOptimisticVersion(expected: number, actual: number): void {
  if (!Number.isInteger(expected) || expected < 0) {
    throw new AppError("precondition_required", "A valid optimistic version is required");
  }
  if (expected !== actual) {
    throw new AppError("precondition_failed", "The resource changed while it was being edited", {
      safeDetails: { expected, actual },
    });
  }
}

export function parseIfMatch(value: string | null): number {
  if (!value) throw new AppError("precondition_required", "If-Match is required");
  const match = /^(?:W\/)?"?(\d+)"?$/.exec(value.trim());
  if (!match?.[1]) throw new AppError("precondition_required", "If-Match must contain a resource version");
  return Number(match[1]);
}

export function nextFencingToken(current: bigint | number | null): bigint {
  return BigInt(current ?? 0) + 1n;
}

