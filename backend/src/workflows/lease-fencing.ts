export type WorkflowFencingToken = string;

type FencedLeaseWhere = {
  workspaceId: string;
  runId: string;
  ownerId: string;
  fencingToken: bigint;
  releasedAt: null;
  expiresAt: { gt: Date };
};

type FencedLeaseUpdate = {
  where: FencedLeaseWhere;
  data: { expiresAt?: Date; releasedAt?: Date };
};

type LeaseUpdater = (args: FencedLeaseUpdate) => Promise<{ count: number }>;

export class StaleWorkflowLeaseError extends Error {
  constructor(message = "Workflow lease fencing token is stale or no longer active.") {
    super(message);
    this.name = "StaleWorkflowLeaseError";
  }
}

export function parseWorkflowFencingToken(token: WorkflowFencingToken) {
  if (!/^[1-9][0-9]*$/.test(token)) throw new StaleWorkflowLeaseError("Workflow lease fencing token is invalid.");
  return BigInt(token);
}

export function fencedLeaseWhere(
  workspaceId: string,
  runId: string,
  fencingToken: WorkflowFencingToken,
  now = new Date(),
): FencedLeaseWhere {
  return {
    workspaceId,
    runId,
    ownerId: runId,
    fencingToken: parseWorkflowFencingToken(fencingToken),
    releasedAt: null,
    expiresAt: { gt: now },
  };
}

export async function renewCurrentRunLease(
  updateMany: LeaseUpdater,
  input: {
    workspaceId: string;
    runId: string;
    fencingToken: WorkflowFencingToken;
    now?: Date;
    expiresAt?: Date;
  },
) {
  const now = input.now ?? new Date();
  const result = await updateMany({
    where: fencedLeaseWhere(input.workspaceId, input.runId, input.fencingToken, now),
    data: { expiresAt: input.expiresAt ?? new Date(now.getTime() + 45 * 60_000) },
  });
  return result.count === 1;
}

export async function requireCurrentRunLease(
  updateMany: LeaseUpdater,
  input: Parameters<typeof renewCurrentRunLease>[1],
  message?: string,
) {
  if (!(await renewCurrentRunLease(updateMany, input))) throw new StaleWorkflowLeaseError(message);
}

export async function releaseCurrentRunLease(
  updateMany: LeaseUpdater,
  input: {
    workspaceId: string;
    runId: string;
    fencingToken: WorkflowFencingToken;
    now?: Date;
  },
) {
  const now = input.now ?? new Date();
  const result = await updateMany({
    where: fencedLeaseWhere(input.workspaceId, input.runId, input.fencingToken, now),
    data: { releasedAt: now },
  });
  return result.count === 1;
}
