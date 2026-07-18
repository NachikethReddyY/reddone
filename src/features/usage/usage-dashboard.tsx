"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { CircleDollarSign, Coins, Gauge, PhoneCall, RefreshCw } from "lucide-react";
import { useMemo, useState, type FormEvent } from "react";

import {
  Alert,
  Button,
  DataTable,
  EmptyState,
  SegmentedControl,
  Skeleton,
  StatTile,
  StatusBadge,
  Surface,
} from "@/components/ui";
import type { UsageReport } from "@/contracts";
import { UsageTimeSeries } from "./usage-chart";
import {
  applyUsageRangePreset,
  buildUsagePageSearchParams,
  createUsageFilters,
  formatBucketDate,
  formatMicrodollars,
  formatMicrodollarsAccessible,
  formatProviderCalls,
  formatTimestamp,
  formatTokens,
  titleCase,
  validateUsageFilters,
  type UsageFilterState,
  type UsageMetric,
  type UsageRangePreset,
} from "./usage-format";
import { useUsageReportQuery } from "./usage-queries";

const rangePresets: Array<{ value: Exclude<UsageRangePreset, "custom">; label: string }> = [
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" },
  { value: "90d", label: "90 days" },
];

const runKinds = ["research", "build", "polish", "release", "rollback"] as const;

function usageOptions(report: UsageReport | undefined, dimension: "model" | "operation", selected: string) {
  const values = report?.breakdowns.filter((item) => item.dimension === dimension).map((item) => item.value) ?? [];
  if (selected) values.push(selected);
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function projectOptions(report: UsageReport | undefined, selected: string) {
  const options = new Map<string, string>();
  for (const run of report?.recentRuns ?? []) options.set(run.projectId, run.projectName);
  if (selected && !options.has(selected)) options.set(selected, "Selected project");
  return [...options].map(([id, name]) => ({ id, name })).sort((left, right) => left.name.localeCompare(right.name));
}

function usageFiltersEqual(left: UsageFilterState, right: UsageFilterState) {
  return left.preset === right.preset
    && left.from === right.from
    && left.to === right.to
    && left.granularity === right.granularity
    && left.projectId === right.projectId
    && left.runKind === right.runKind
    && left.operation === right.operation
    && left.model === right.model;
}

function statusTone(status: UsageReport["recentRuns"][number]["status"]) {
  if (status === "succeeded") return "success" as const;
  if (status === "failed") return "danger" as const;
  if (["waiting_for_approval", "cancel_requested"].includes(status)) return "warning" as const;
  if (status === "running") return "info" as const;
  return "neutral" as const;
}

function UsageSkeleton() {
  return (
    <div aria-label="Loading usage" className="usage-stack" role="status">
      <span className="sr-only">Loading usage…</span>
      <Skeleton className="usage-skeleton-filters" />
      <div className="usage-stat-grid">{Array.from({ length: 4 }, (_, index) => <Skeleton className="usage-skeleton-stat" key={index} />)}</div>
      <Skeleton className="usage-skeleton-chart" />
      <div className="usage-lower-grid"><Skeleton className="usage-skeleton-table" /><Skeleton className="usage-skeleton-table" /></div>
    </div>
  );
}

function UsageFilters({
  filters,
  report,
  pending,
  error,
  canReset,
  onChange,
  onPreset,
  onSubmit,
  onReset,
}: {
  filters: UsageFilterState;
  report: UsageReport | undefined;
  pending: boolean;
  error: string;
  canReset: boolean;
  onChange: (next: UsageFilterState) => void;
  onPreset: (preset: Exclude<UsageRangePreset, "custom">) => void;
  onSubmit: () => void;
  onReset: () => void;
}) {
  const models = usageOptions(report, "model", filters.model);
  const operations = usageOptions(report, "operation", filters.operation);
  const projects = projectOptions(report, filters.projectId);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onSubmit();
  }

  return (
    <Surface className="usage-filter-surface">
      <form aria-label="Usage filters" onSubmit={submit}>
        <div className="usage-range-row">
          <div className="usage-filter-label"><strong>Date range</strong><span>UTC buckets</span></div>
          <div aria-label="Date range presets" className="usage-range-presets" role="group">
            {rangePresets.map((preset) => (
              <button aria-pressed={filters.preset === preset.value} key={preset.value} onClick={() => onPreset(preset.value)} type="button">{preset.label}</button>
            ))}
          </div>
          <label className="usage-date-field"><span>From</span><input max={filters.to} onChange={(event) => onChange({ ...filters, preset: "custom", from: event.target.value })} type="date" value={filters.from} /></label>
          <label className="usage-date-field"><span>To</span><input min={filters.from} onChange={(event) => onChange({ ...filters, preset: "custom", to: event.target.value })} type="date" value={filters.to} /></label>
        </div>
        <div className="usage-dimension-row">
          <label><span>Granularity</span><select onChange={(event) => onChange({ ...filters, granularity: event.target.value as UsageFilterState["granularity"] })} value={filters.granularity}><option value="day">Day</option><option value="week">Week</option></select></label>
          <label><span>Project</span><select onChange={(event) => onChange({ ...filters, projectId: event.target.value })} value={filters.projectId}><option value="">All projects</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>
          <label><span>Run kind</span><select onChange={(event) => onChange({ ...filters, runKind: event.target.value as UsageFilterState["runKind"] })} value={filters.runKind}><option value="">All run kinds</option>{runKinds.map((kind) => <option key={kind} value={kind}>{titleCase(kind)}</option>)}</select></label>
          <label><span>Operation</span><select onChange={(event) => onChange({ ...filters, operation: event.target.value })} value={filters.operation}><option value="">All operations</option>{operations.map((operation) => <option key={operation} value={operation}>{titleCase(operation)}</option>)}</select></label>
          <label><span>Model</span><select onChange={(event) => onChange({ ...filters, model: event.target.value })} value={filters.model}><option value="">All models</option>{models.map((model) => <option key={model} value={model}>{model}</option>)}</select></label>
          <div className="usage-filter-actions">
            <Button disabled={pending} kind="primary" type="submit">{pending ? "Updating…" : "Apply filters"}</Button>
            <Button disabled={pending || !canReset} kind="ghost" onClick={onReset} type="button">Clear</Button>
          </div>
        </div>
        {error && <p className="usage-filter-error" role="alert">{error}</p>}
      </form>
    </Surface>
  );
}

export function UsageBucketTable({ report }: { report: UsageReport }) {
  return (
    <DataTable caption="Usage by time bucket" className="usage-bucket-table" data-testid="usage-bucket-table">
      <thead><tr><th scope="col">Period</th><th scope="col">Input tokens</th><th scope="col">Output tokens</th><th scope="col">Total tokens</th><th scope="col">Kimi calls</th><th scope="col">Provider cost</th></tr></thead>
      <tbody>
        {report.buckets.map((bucket) => (
          <tr key={bucket.start}>
            <th scope="row">{formatBucketDate(bucket.start, report.query.granularity, true)}</th>
            <td>{formatTokens(bucket.inputTokens)}</td>
            <td>{formatTokens(bucket.outputTokens)}</td>
            <td>{formatTokens(bucket.totalTokens)}</td>
            <td>{formatProviderCalls(bucket.providerCalls)}</td>
            <td aria-label={formatMicrodollarsAccessible(bucket.costMicros)}>{formatMicrodollars(bucket.costMicros)}</td>
          </tr>
        ))}
      </tbody>
    </DataTable>
  );
}

function BreakdownTable({ report }: { report: UsageReport }) {
  return (
    <DataTable caption="Usage breakdown" compact>
      <thead><tr><th scope="col">Dimension</th><th scope="col">Value</th><th scope="col">Calls</th><th scope="col">Tokens</th><th scope="col">Provider cost</th></tr></thead>
      <tbody>
        {report.breakdowns.map((item) => (
          <tr key={`${item.dimension}-${item.value}`}>
            <td>{titleCase(item.dimension)}</td>
            <th scope="row">{item.dimension === "operation" ? titleCase(item.value) : item.value}</th>
            <td>{formatProviderCalls(item.providerCalls)}</td>
            <td>{formatTokens(item.totalTokens)}</td>
            <td aria-label={formatMicrodollarsAccessible(item.costMicros)}>{formatMicrodollars(item.costMicros)}</td>
          </tr>
        ))}
      </tbody>
    </DataTable>
  );
}

function RecentRuns({ report }: { report: UsageReport }) {
  if (report.recentRuns.length === 0) {
    return <EmptyState icon="activity" title="No recent run summaries" description="Runs with usage in this date range will appear here." />;
  }
  return (
    <div className="usage-run-list">
      {report.recentRuns.map((run) => (
        <Link className="usage-run-row" href={`/projects/${run.projectId}/builds`} key={run.runId}>
          <span className="usage-run-main"><strong>{run.projectName}</strong><small>{titleCase(run.kind)} · {run.models.join(", ") || "Model unavailable"}</small></span>
          <span className="usage-run-metrics"><b>{formatTokens(run.totalTokens, true)} tokens</b><small>{formatMicrodollars(run.costMicros)} provider cost</small></span>
          <span className="usage-run-state"><StatusBadge tone={statusTone(run.status)}>{titleCase(run.status)}</StatusBadge><time dateTime={run.finishedAt ?? run.startedAt ?? undefined}>{formatTimestamp(run.finishedAt ?? run.startedAt)}</time></span>
        </Link>
      ))}
    </div>
  );
}

export function UsageDashboard({ initialFilters }: { initialFilters: UsageFilterState }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [now] = useState(() => new Date());
  const defaultFilters = useMemo(() => createUsageFilters(now), [now]);
  const [filters, setFilters] = useState(() => ({ ...initialFilters }));
  const [appliedFilters, setAppliedFilters] = useState(() => ({ ...initialFilters }));
  const [filterError, setFilterError] = useState("");
  const [metric, setMetric] = useState<UsageMetric>("cost");
  const usageQuery = useUsageReportQuery(appliedFilters);
  const report = usageQuery.data;
  const empty = report?.totals.providerCalls === 0;
  const rangeLabel = useMemo(() => report ? `${formatBucketDate(report.query.from, report.query.granularity, true)} to ${formatBucketDate(new Date(new Date(report.query.to).getTime() - 1).toISOString(), report.query.granularity, true)}` : "", [report]);

  function commitUrl(next: UsageFilterState) {
    const current = new URLSearchParams(searchParams.toString());
    const nextSearch = buildUsagePageSearchParams(next, current).toString();
    if (nextSearch === current.toString()) return;
    router.replace(`${pathname}?${nextSearch}`, { scroll: false });
  }

  function applyFilters() {
    const validationError = validateUsageFilters(filters);
    setFilterError(validationError);
    if (!validationError) {
      const next = { ...filters };
      setAppliedFilters(next);
      commitUrl(next);
    }
  }

  function applyPreset(preset: Exclude<UsageRangePreset, "custom">) {
    const next = applyUsageRangePreset(filters, preset, now);
    setFilters(next);
    setFilterError("");
    setAppliedFilters(next);
    commitUrl(next);
  }

  function resetFilters() {
    const next = createUsageFilters(now);
    setFilters(next);
    setFilterError("");
    setAppliedFilters(next);
    commitUrl(next);
  }

  if (usageQuery.isPending && !report) return <UsageSkeleton />;
  if (usageQuery.isError && !report) {
    return (
      <Surface className="usage-error-state">
        <EmptyState icon="warning" title="Usage could not be loaded" description={usageQuery.error instanceof Error ? usageQuery.error.message : "The usage report is temporarily unavailable."} action={<Button icon="retry" kind="primary" onClick={() => void usageQuery.refetch()}>Retry</Button>} />
      </Surface>
    );
  }
  if (!report) return null;

  return (
    <div aria-busy={usageQuery.isFetching} className={`usage-stack ${usageQuery.isFetching ? "is-refreshing" : ""}`}>
      <UsageFilters canReset={!usageFiltersEqual(filters, defaultFilters)} error={filterError} filters={filters} onChange={setFilters} onPreset={applyPreset} onReset={resetFilters} onSubmit={applyFilters} pending={usageQuery.isFetching} report={report} />
      <div aria-live="polite" className="usage-notices">
        {report.simulated && <Alert title="Simulated demo usage" tone="info">Every total, bucket, and run summary on this page is generated demo data, not live provider usage.</Alert>}
        {usageQuery.isError && <Alert title="Latest refresh failed" tone="warning">The previous report is still shown. <button className="usage-inline-button" onClick={() => void usageQuery.refetch()} type="button"><RefreshCw aria-hidden="true" size={14} />Retry refresh</button></Alert>}
      </div>
      <section aria-label="Usage totals" className="usage-stat-grid">
        <StatTile className="usage-stat-cost" detail={`${rangeLabel}. Recorded upstream spend.`} icon={<CircleDollarSign aria-hidden="true" size={19} />} label="Provider cost" tone="accent" value={<span aria-label={formatMicrodollarsAccessible(report.totals.costMicros)}>{formatMicrodollars(report.totals.costMicros)}</span>} />
        <StatTile detail={`${formatTokens(report.totals.inputTokens)} input · ${formatTokens(report.totals.outputTokens)} output`} icon={<Coins aria-hidden="true" size={19} />} label="Total tokens" value={formatTokens(report.totals.totalTokens, true)} />
        <StatTile detail="Provider calls represented in this report." icon={<PhoneCall aria-hidden="true" size={19} />} label="Kimi calls" value={formatProviderCalls(report.totals.providerCalls)} />
        <StatTile detail={`Across ${formatProviderCalls(report.totals.completedRuns)} completed runs`} icon={<Gauge aria-hidden="true" size={19} />} label="Average cost per completed run" value={<span aria-label={formatMicrodollarsAccessible(report.totals.averageCostPerCompletedRunMicros)}>{formatMicrodollars(report.totals.averageCostPerCompletedRunMicros)}</span>} />
      </section>
      <Surface className="usage-chart-surface">
        <header className="usage-section-heading usage-chart-heading">
          <div><span className="eyebrow">Time series</span><h2>{metric === "cost" ? "Provider cost over time" : "Token volume over time"}</h2><p>One UTC time scale and one value scale. Focus a bucket and use arrow keys to inspect adjacent periods.</p></div>
          <SegmentedControl label="Usage chart metric" onChange={(value) => setMetric(value as UsageMetric)} options={[{ value: "cost", label: "Cost" }, { value: "tokens", label: "Tokens" }]} value={metric} />
        </header>
        {empty ? <EmptyState icon="activity" title="No usage in this range" description="Change the date range or clear dimension filters. No provider calls were recorded for the current slice." /> : <UsageTimeSeries metric={metric} report={report} />}
      </Surface>
      <section className="usage-table-section">
        <div className="usage-section-heading"><div><span className="eyebrow">Accessible table</span><h2>Every time bucket</h2><p>The table contains the same buckets and measures as the chart and remains available without hover or color.</p></div></div>
        <UsageBucketTable report={report} />
      </section>
      <div className="usage-lower-grid">
        <section className="usage-breakdown-section">
          <div className="usage-section-heading"><div><span className="eyebrow">Breakdown</span><h2>Models and operations</h2><p>Actual ledger dimensions, ordered by provider cost.</p></div></div>
          {report.breakdowns.length > 0 ? <BreakdownTable report={report} /> : <EmptyState icon="filter" title="No breakdown rows" description="There are no model or operation records for this report slice." />}
        </section>
        <section className="usage-runs-section">
          <div className="usage-section-heading"><div><span className="eyebrow">Recent runs</span><h2>Run summaries</h2><p>Runs with recorded usage in the selected period.</p></div></div>
          <RecentRuns report={report} />
        </section>
      </div>
      <aside className="usage-cost-note">
        <CircleDollarSign aria-hidden="true" size={19} />
        <div><strong>Provider usage remains independently measurable.</strong><p>This page reports recorded upstream Kimi cost and tokens. Beta access entitlements are managed separately and are never inferred from token usage.</p></div>
      </aside>
      <p className="usage-generated-at">Report generated {formatTimestamp(report.generatedAt)} · Source: {report.simulated ? "simulated demo data" : "actual usage ledger"}</p>
    </div>
  );
}
