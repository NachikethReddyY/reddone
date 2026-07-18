import "server-only";

import type { Provider } from "@prisma/client";

import {
  DEFAULT_BUILDER_MODEL,
  DEFAULT_RESEARCH_MODEL,
  RunUsageAggregateSchema,
  RunUsageEntrySchema,
  UsageReportSchema,
  type ResolvedUsageQuery,
  type RunUsageAggregate,
  type RunUsageEntry,
  type UsageReport,
} from "@/contracts";
import { demoStore, getProject, normalizeDemoProjectId } from "@/workflows/demo-store";
import { getDb } from "./db";

const RUN_KIND = {
  research: "RESEARCH",
  build: "BUILD",
  polish: "POLISH",
  release: "RELEASE",
  rollback: "ROLLBACK",
} as const;

export type UsageEntryLike = {
  id: string;
  projectId: string;
  runId: string;
  provider: Provider | "KIMI";
  externalUsageId: string | null;
  model: string;
  operation: string;
  inputUnits: bigint;
  outputUnits: bigint;
  inputRateMicrosPerMillion: bigint | null;
  outputRateMicrosPerMillion: bigint | null;
  pricingVersion: string | null;
  costMicros: bigint;
  occurredAt: Date;
  run: {
    kind: string;
    status: string;
    startedAt: Date | null;
    finishedAt: Date | null;
    project: { name: string };
  };
};

type Totals = {
  calls: number;
  input: bigint;
  output: bigint;
  cost: bigint;
};

function emptyTotals(): Totals {
  return { calls: 0, input: 0n, output: 0n, cost: 0n };
}

function addEntry(totals: Totals, entry: Pick<UsageEntryLike, "inputUnits" | "outputUnits" | "costMicros">) {
  totals.calls += 1;
  totals.input += entry.inputUnits;
  totals.output += entry.outputUnits;
  totals.cost += entry.costMicros;
}

function decimal(value: bigint) {
  return value.toString();
}

function serializedTotals(totals: Totals) {
  return {
    providerCalls: totals.calls,
    inputTokens: decimal(totals.input),
    outputTokens: decimal(totals.output),
    totalTokens: decimal(totals.input + totals.output),
    costMicros: decimal(totals.cost),
  };
}

function startOfBucket(date: Date, granularity: ResolvedUsageQuery["granularity"]) {
  const start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  if (granularity === "week") {
    const mondayOffset = (start.getUTCDay() + 6) % 7;
    start.setUTCDate(start.getUTCDate() - mondayOffset);
  }
  return start;
}

function nextBucket(date: Date, granularity: ResolvedUsageQuery["granularity"]) {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + (granularity === "week" ? 7 : 1));
  return next;
}

function normalizeRunKind(kind: string) {
  return kind.toLowerCase() as keyof typeof RUN_KIND;
}

function normalizeRunStatus(status: string) {
  return status.toLowerCase() === "awaiting_approval" ? "waiting_for_approval" : status.toLowerCase();
}

export function aggregateUsageReport(input: {
  entries: UsageEntryLike[];
  query: ResolvedUsageQuery;
  source: "actual" | "simulated";
  generatedAt?: Date;
}): UsageReport {
  const totals = emptyTotals();
  const completedRunIds = new Set<string>();
  let completedRunCost = 0n;
  const buckets = new Map<string, Totals>();
  const breakdowns = new Map<string, Totals>();
  const runs = new Map<string, { entry: UsageEntryLike; totals: Totals; models: Set<string> }>();

  for (const entry of input.entries) {
    if (entry.provider !== "KIMI") continue;
    addEntry(totals, entry);
    if (entry.run.status === "SUCCEEDED") {
      completedRunIds.add(entry.runId);
      completedRunCost += entry.costMicros;
    }
    const bucketKey = startOfBucket(entry.occurredAt, input.query.granularity).toISOString();
    const bucket = buckets.get(bucketKey) ?? emptyTotals();
    addEntry(bucket, entry);
    buckets.set(bucketKey, bucket);
    for (const [dimension, value] of [["model", entry.model], ["operation", entry.operation]] as const) {
      const key = `${dimension}\0${value}`;
      const breakdown = breakdowns.get(key) ?? emptyTotals();
      addEntry(breakdown, entry);
      breakdowns.set(key, breakdown);
    }
    const run = runs.get(entry.runId) ?? { entry, totals: emptyTotals(), models: new Set<string>() };
    if (entry.occurredAt > run.entry.occurredAt) run.entry = entry;
    addEntry(run.totals, entry);
    run.models.add(entry.model);
    runs.set(entry.runId, run);
  }

  const from = new Date(input.query.from);
  const to = new Date(input.query.to);
  const serializedBuckets = [];
  for (let start = startOfBucket(from, input.query.granularity); start < to; start = nextBucket(start, input.query.granularity)) {
    const end = nextBucket(start, input.query.granularity);
    const bucket = buckets.get(start.toISOString()) ?? emptyTotals();
    serializedBuckets.push({
      start: start.toISOString(),
      end: new Date(Math.min(end.getTime(), to.getTime())).toISOString(),
      ...serializedTotals(bucket),
    });
  }

  const completedRuns = completedRunIds.size;
  const averageCostPerCompletedRunMicros = completedRuns > 0 ? completedRunCost / BigInt(completedRuns) : 0n;
  return UsageReportSchema.parse({
    source: input.source,
    simulated: input.source === "simulated",
    query: input.query,
    totals: {
      ...serializedTotals(totals),
      completedRuns,
      averageCostPerCompletedRunMicros: decimal(averageCostPerCompletedRunMicros),
    },
    buckets: serializedBuckets,
    breakdowns: [...breakdowns.entries()]
      .map(([key, value]) => {
        const [dimension, label] = key.split("\0") as ["model" | "operation", string];
        return { dimension, value: label, ...serializedTotals(value) };
      })
      .sort((left, right) => {
        const leftCost = BigInt(left.costMicros);
        const rightCost = BigInt(right.costMicros);
        return rightCost > leftCost ? 1 : rightCost < leftCost ? -1 : 0;
      }),
    recentRuns: [...runs.values()]
      .sort((left, right) => right.entry.occurredAt.getTime() - left.entry.occurredAt.getTime())
      .slice(0, 20)
      .map(({ entry, totals: runTotals, models }) => ({
        runId: entry.runId,
        projectId: entry.projectId,
        projectName: entry.run.project.name,
        kind: normalizeRunKind(entry.run.kind),
        status: normalizeRunStatus(entry.run.status),
        models: [...models].sort(),
        ...serializedTotals(runTotals),
        startedAt: entry.run.startedAt?.toISOString() ?? null,
        finishedAt: entry.run.finishedAt?.toISOString() ?? null,
      })),
    generatedAt: (input.generatedAt ?? new Date()).toISOString(),
  });
}

export async function getUsageReport(workspaceId: string, query: ResolvedUsageQuery) {
  const entries = await getDb().usageLedger.findMany({
    where: {
      workspaceId,
      provider: "KIMI",
      runId: { not: null },
      occurredAt: { gte: new Date(query.from), lt: new Date(query.to) },
      ...(query.projectId ? { projectId: query.projectId } : {}),
      ...(query.operation ? { operation: query.operation } : {}),
      ...(query.model ? { model: query.model } : {}),
      ...(query.runKind ? { run: { kind: RUN_KIND[query.runKind] } } : {}),
    },
    include: { run: { include: { project: { select: { name: true } } } } },
    orderBy: { occurredAt: "asc" },
  });
  // The legacy usage dashboard remains run-oriented; conversation usage is stored
  // separately by the same ledger and will be exposed through its workspace view.
  const runEntries = entries.filter((entry) => entry.runId !== null && entry.run !== null) as UsageEntryLike[];
  return aggregateUsageReport({ entries: runEntries, query, source: "actual" });
}

export function getDemoUsageReport(query: ResolvedUsageQuery) {
  const entries: UsageEntryLike[] = [...demoStore.runs.values()]
    .filter((run) => !query.projectId || run.projectId === normalizeDemoProjectId(query.projectId))
    .filter((run) => !query.runKind || run.kind === query.runKind)
    .map((run) => {
      const project = getProject(run.projectId)!;
      const model = run.kind === "build" || run.kind === "polish" ? DEFAULT_BUILDER_MODEL : DEFAULT_RESEARCH_MODEL;
      const operation = `simulated_${run.kind}`;
      const turns = Math.max(run.budget.modelTurns, 1);
      return {
        id: `${run.id}:simulated-usage`,
        projectId: run.projectId,
        runId: run.id,
        provider: "KIMI" as const,
        externalUsageId: null,
        model,
        operation,
        inputUnits: BigInt(turns * 1_200),
        outputUnits: BigInt(turns * 800),
        inputRateMicrosPerMillion: null,
        outputRateMicrosPerMillion: null,
        pricingVersion: null,
        costMicros: BigInt(run.budget.spentCents * 10_000),
        occurredAt: new Date(run.completedAt ?? run.startedAt),
        run: {
          kind: run.kind.toUpperCase(),
          status: run.status.toUpperCase(),
          startedAt: new Date(run.startedAt),
          finishedAt: run.completedAt ? new Date(run.completedAt) : null,
          project: { name: project.name },
        },
      };
    })
    .filter((entry) => entry.occurredAt >= new Date(query.from) && entry.occurredAt < new Date(query.to))
    .filter((entry) => !query.operation || entry.operation === query.operation)
    .filter((entry) => !query.model || entry.model === query.model);
  return aggregateUsageReport({ entries, query, source: "simulated" });
}

export function serializeRunUsage(entries: Array<{
  id: string;
  provider: Provider | "KIMI";
  externalUsageId: string | null;
  model: string;
  operation: string;
  inputUnits: bigint;
  outputUnits: bigint;
  inputRateMicrosPerMillion: bigint | null;
  outputRateMicrosPerMillion: bigint | null;
  pricingVersion: string | null;
  costMicros: bigint;
  occurredAt: Date;
}>): { usage: RunUsageAggregate; usageEntries: RunUsageEntry[] } {
  const totals = emptyTotals();
  const models = new Set<string>();
  let pricingSnapshotsComplete = true;
  const usageEntries = entries.map((entry) => {
    addEntry(totals, entry);
    models.add(entry.model);
    const pricingSnapshotAvailable = entry.inputRateMicrosPerMillion !== null
      && entry.outputRateMicrosPerMillion !== null
      && entry.pricingVersion !== null;
    pricingSnapshotsComplete &&= pricingSnapshotAvailable;
    return RunUsageEntrySchema.parse({
      id: entry.id,
      provider: entry.provider.toLowerCase(),
      externalUsageId: entry.externalUsageId,
      model: entry.model,
      operation: entry.operation,
      inputTokens: decimal(entry.inputUnits),
      outputTokens: decimal(entry.outputUnits),
      costMicros: decimal(entry.costMicros),
      inputRateMicrosPerMillion: entry.inputRateMicrosPerMillion?.toString() ?? null,
      outputRateMicrosPerMillion: entry.outputRateMicrosPerMillion?.toString() ?? null,
      pricingVersion: entry.pricingVersion,
      pricingSnapshotAvailable,
      occurredAt: entry.occurredAt.toISOString(),
    });
  });
  const inputUnits = totals.input <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(totals.input) : undefined;
  const outputUnits = totals.output <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(totals.output) : undefined;
  const usage = RunUsageAggregateSchema.parse({
    ...serializedTotals(totals),
    models: [...models].sort(),
    pricingSnapshotsComplete: entries.length === 0 || pricingSnapshotsComplete,
    ...(inputUnits === undefined ? {} : { inputUnits }),
    ...(outputUnits === undefined ? {} : { outputUnits }),
  });
  return { usage, usageEntries };
}

export function serializeDemoRunUsage(run: {
  id: string;
  kind: string;
  startedAt: string;
  budget: { spentCents: number; modelTurns: number };
}) {
  const model = run.kind === "build" || run.kind === "polish" ? DEFAULT_BUILDER_MODEL : DEFAULT_RESEARCH_MODEL;
  const turns = Math.max(run.budget.modelTurns, 1);
  return serializeRunUsage([{
    id: `${run.id}:simulated-usage`,
    provider: "KIMI",
    externalUsageId: null,
    model,
    operation: `simulated_${run.kind}`,
    inputUnits: BigInt(turns * 1_200),
    outputUnits: BigInt(turns * 800),
    inputRateMicrosPerMillion: null,
    outputRateMicrosPerMillion: null,
    pricingVersion: null,
    costMicros: BigInt(run.budget.spentCents * 10_000),
    occurredAt: new Date(run.startedAt),
  }]);
}
