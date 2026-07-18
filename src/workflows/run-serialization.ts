import { DEFAULT_WORKFLOW_MODEL, RunEventPageSchema, RunStateSchema } from "@/contracts";

export type PersistedRunState = {
  id: string;
  projectId: string;
  kind: string;
  model?: string;
  status: string;
  stateVersion: number;
  attempt: number;
  currentStepKey: string | null;
  budgetCeilingMicros: bigint;
  reservedMicros: bigint;
  actualCostMicros: bigint;
  cancelRequestedAt: Date | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  steps?: Array<{
    id: string;
    key: string;
    label: string;
    status: string;
    attempt: number;
    startedAt: Date | null;
    finishedAt: Date | null;
    failureMessage: string | null;
  }>;
};

export function serializeRunState(run: PersistedRunState) {
  return RunStateSchema.parse({
    id: run.id,
    projectId: run.projectId,
    kind: run.kind.toLowerCase(),
    model: run.model ?? DEFAULT_WORKFLOW_MODEL,
    status: run.status.toLowerCase(),
    stateVersion: run.stateVersion,
    attempt: run.attempt,
    currentStepKey: run.currentStepKey,
    steps: (run.steps ?? []).map((step) => ({
      id: step.id,
      key: step.key,
      label: step.label,
      status: step.status.toLowerCase(),
      attempt: step.attempt,
      startedAt: step.startedAt?.toISOString() ?? null,
      finishedAt: step.finishedAt?.toISOString() ?? null,
      summary: step.failureMessage,
    })),
    budgetCeilingMicros: Number(run.budgetCeilingMicros),
    reservedMicros: Number(run.reservedMicros),
    actualCostMicros: Number(run.actualCostMicros),
    cancelRequestedAt: run.cancelRequestedAt?.toISOString() ?? null,
    startedAt: run.startedAt?.toISOString() ?? null,
    finishedAt: run.finishedAt?.toISOString() ?? null,
    createdAt: run.createdAt.toISOString(),
    updatedAt: run.updatedAt.toISOString(),
  });
}

export type RunEventInput = {
  id: string;
  runId: string | null;
  projectId: string | null;
  sequence: number | bigint;
  type: string;
  severity: string;
  message: string;
  data: unknown;
  createdAt: Date | string;
};

function safeSequence(value: number | bigint) {
  const sequence = typeof value === "bigint" ? Number(value) : value;
  if (!Number.isSafeInteger(sequence) || sequence <= 0) {
    throw new Error("Run event sequence is outside the safe cursor range.");
  }
  return sequence;
}

export function serializeRunEventPage(input: {
  items: RunEventInput[];
  nextCursor: string | null;
  retentionStartsAt: Date | string;
}) {
  return RunEventPageSchema.parse({
    items: input.items.map((event) => ({
      id: event.id,
      runId: event.runId,
      projectId: event.projectId,
      sequence: safeSequence(event.sequence),
      type: event.type,
      severity: event.severity.toLowerCase(),
      message: event.message,
      data: event.data,
      createdAt: event.createdAt instanceof Date ? event.createdAt.toISOString() : event.createdAt,
    })),
    nextCursor: input.nextCursor,
    retentionStartsAt: input.retentionStartsAt instanceof Date
      ? input.retentionStartsAt.toISOString()
      : input.retentionStartsAt,
  });
}
