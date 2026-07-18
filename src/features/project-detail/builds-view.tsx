"use client";

import { useEffect, useMemo, useState } from "react";

import { Icon } from "@/components/icons";
import { Button, ButtonLink, EmptyState, Metric, Skeleton, StatusBadge, Surface } from "@/components/ui";
import { DEFAULT_WORKFLOW_MODEL, type JsonValue, WorkflowModelOptions, type WorkflowModel } from "@/contracts";
import {
  useCancelRunMutation,
  useProjectQuery,
  useRetryRunMutation,
  useRunEstimateQuery,
  useRunEventsQuery,
  useRunQuery,
  useStartRunMutation,
  type ProjectRunDetail,
} from "@/features/projects/project-queries";
import { buildSteps as demoBuildSteps, verificationChecks as demoVerificationChecks } from "@/demo-data/control-plane";

type VerificationGate = { name: string; status: string; durationMs: number; summary: string };
type TimelineStep = { id: string; label: string; detail: string; duration: string; state: "complete" | "running" | "failed" | "pending" };

function formatMoney(micros: number | string | undefined) {
  const amount = typeof micros === "string" ? Number(micros) : micros;
  if (amount === undefined || !Number.isFinite(amount)) return "—";
  return new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", minimumFractionDigits: 2 }).format(amount / 1_000_000);
}

function formatTokens(value: string | undefined) {
  if (!value) return "0";
  const amount = Number(value);
  return Number.isFinite(amount) ? new Intl.NumberFormat().format(amount) : value;
}

function formatDuration(startedAt?: string | null, finishedAt?: string | null, now = Date.now()) {
  if (!startedAt) return "Not started";
  const elapsed = Math.max(0, new Date(finishedAt ?? now).getTime() - new Date(startedAt).getTime());
  const minutes = Math.floor(elapsed / 60_000);
  const seconds = Math.floor((elapsed % 60_000) / 1_000);
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

function shortHash(value: string | null | undefined) {
  return value ? `${value.slice(0, 12)}…${value.slice(-8)}` : "Not available";
}

function readableStage(value: string | null | undefined) {
  return value ? value.replace(/^build\./, "").replaceAll("_", " ").replaceAll(".", " ") : "Waiting for the next durable stage";
}

function timelineState(status: string): TimelineStep["state"] {
  if (status === "succeeded") return "complete";
  if (status === "running") return "running";
  if (status === "failed" || status === "canceled") return "failed";
  return "pending";
}

function verificationGates(report: JsonValue | undefined): VerificationGate[] {
  if (!report || Array.isArray(report) || typeof report !== "object") return [];
  const gates = report.gates;
  if (!Array.isArray(gates)) return [];
  return gates.flatMap((value) => {
    if (!value || Array.isArray(value) || typeof value !== "object") return [];
    const name = typeof value.name === "string" ? value.name : null;
    const status = typeof value.status === "string" ? value.status : null;
    if (!name || !status) return [];
    return [{
      name,
      status: status.toLowerCase(),
      durationMs: typeof value.durationMs === "number" ? value.durationMs : 0,
      summary: typeof value.summary === "string" ? value.summary : "No additional summary was retained.",
    }];
  });
}

function isLiveRun(run: ProjectRunDetail): run is Extract<ProjectRunDetail, { mode: "live" }> {
  return run.mode === "live";
}

function BuildLoading() {
  return <div className="build-room-loading" aria-busy="true" aria-label="Loading build control"><Skeleton className="loading-title" /><Skeleton className="loading-panel" /><div className="metric-grid four-col">{Array.from({ length: 4 }, (_, index) => <Skeleton className="loading-panel compact" key={index} />)}</div></div>;
}

function RunDetails({ run, timeline, logLines }: { run: ProjectRunDetail; timeline: TimelineStep[]; logLines: string[] }) {
  return (
    <details className="run-details-disclosure">
      <summary><span><Icon name="activity" size={17} />Technical details</span><small>Timeline, events, and immutable hashes</small></summary>
      <div className="run-details-content">
        <Surface className="build-timeline">
          <div className="surface-head"><div><span className="eyebrow">Durable execution</span><h2>Run timeline</h2></div><StatusBadge tone={run.status === "succeeded" ? "success" : run.status === "failed" ? "danger" : "info"}>{run.status}</StatusBadge></div>
          <div className="build-steps">{timeline.length ? timeline.map((step, index) => <div className={`build-step is-${step.state}`} key={step.id}><span className="build-step-marker">{step.state === "complete" ? <Icon name="check" size={15} /> : step.state === "failed" ? <Icon name="warning" size={15} /> : <span />}</span><div><small>Step {String(index + 1).padStart(2, "0")}</small><strong>{step.label}</strong><p>{step.detail}</p></div><time>{step.duration}</time>{index < timeline.length - 1 && <i aria-hidden="true" />}</div>) : <p className="empty-copy">No persisted workflow-step details were returned.</p>}</div>
        </Surface>
        <Surface className="log-console">
          <div className="console-head"><div><span className="console-lights" aria-hidden="true"><i /><i /><i /></span><strong>{run.id.slice(0, 18)} / retained events</strong></div></div>
          {logLines.length ? <pre aria-label="Build logs" tabIndex={0}>{logLines.map((line, index) => <code key={`${line}-${index}`}><span>{String(index + 1).padStart(2, "0")}</span>{line}</code>)}</pre> : <p className="empty-copy">No retained activity events are available.</p>}
        </Surface>
      </div>
    </details>
  );
}

export function BuildsView({ projectId }: { projectId: string }) {
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [model, setModel] = useState<WorkflowModel>(DEFAULT_WORKFLOW_MODEL);
  const [now, setNow] = useState(() => Date.now());
  const projectQuery = useProjectQuery(projectId);
  const latestBuildId = selectedRunId ?? projectQuery.data?.runs.find((run) => run.kind === "build" || run.kind === "polish")?.id ?? null;
  const runQuery = useRunQuery(latestBuildId);
  const run = runQuery.data ?? null;
  const active = Boolean(run && ["queued", "running", "cancel_requested"].includes(run.status));
  const eventsQuery = useRunEventsQuery(latestBuildId, active);
  const estimateQuery = useRunEstimateQuery(projectId, "build", model, Boolean(projectQuery.data?.spec?.status === "approved" && !latestBuildId));
  const startRun = useStartRunMutation(projectId);
  const cancelRun = useCancelRunMutation();
  const retryRun = useRetryRunMutation();

  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [active]);

  const logLines = useMemo(() => (eventsQuery.data?.items ?? []).map((event) => `${new Date(event.createdAt).toISOString()}  ${event.severity.padEnd(7)} ${event.type}  ${event.message}`), [eventsQuery.data?.items]);
  const isDemo = run?.mode === "demo" || run?.mode === "import";
  const artifacts = run && isLiveRun(run) ? run.artifacts : [];
  const outputArtifact = artifacts.find((artifact) => artifact.kind === "vercel_output") ?? artifacts.at(-1);
  const sourceArtifact = artifacts.find((artifact) => artifact.kind === "verified_source");
  const verification = outputArtifact?.verification ?? null;
  const gates = verificationGates(verification?.report) .concat([]);
  const resolvedGates = gates.length ? gates : isDemo && run?.status === "succeeded"
    ? demoVerificationChecks.map(([name, status, summary]) => ({ name, status: status.toLowerCase(), durationMs: 0, summary }))
    : [];
  const timeline: TimelineStep[] = run?.steps.length
    ? run.steps.map((step) => ({ id: step.key, label: step.label, detail: step.summary ?? `Attempt ${step.attempt}`, duration: formatDuration(step.startedAt, step.finishedAt), state: timelineState(step.status) }))
    : isDemo && run?.status === "succeeded"
      ? demoBuildSteps.map((step) => ({ ...step, state: step.state === "active" ? "running" : step.state as TimelineStep["state"] }))
      : [];
  const currentStep = run?.steps.find((step) => step.status === "running")?.label ?? readableStage(run?.currentStepKey ?? (run && !isLiveRun(run) ? run.currentStep : null));
  const estimate = estimateQuery.data;
  const project = projectQuery.data;

  if (projectQuery.isPending || latestBuildId && runQuery.isPending) return <BuildLoading />;
  if (!project) {
    const error = projectQuery.error instanceof Error ? projectQuery.error.message : "The project build state is unavailable.";
    return <EmptyState icon="warning" title="Build control unavailable" description={error} action={<Button icon="retry" onClick={() => void projectQuery.refetch()}>Retry loading</Button>} />;
  }
  if (runQuery.isError && latestBuildId) {
    const error = runQuery.error instanceof Error ? runQuery.error.message : "The latest build could not be restored.";
    return <EmptyState icon="warning" title="Build run unavailable" description={error} action={<Button icon="retry" onClick={() => void runQuery.refetch()}>Retry loading</Button>} />;
  }
  const currentProject = project;

  async function startBuild() {
    if (!currentProject.spec || currentProject.spec.status !== "approved") {
      setNotice("Approve the current ProductSpec before starting a build.");
      return;
    }
    setNotice("");
    try {
      const created = await startRun.mutateAsync({
        kind: "build",
        model,
        projectVersion: currentProject.optimisticVersion,
        budgetCeilingMicros: currentProject.maxCostMicrosPerRun,
        specVersionId: currentProject.spec.id,
      });
      setSelectedRunId(created.id);
      setNotice("Build queued with the approved ProductSpec and a fresh budget reservation.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "The build could not start.");
    }
  }

  async function cancelBuild() {
    if (!run) return;
    setNotice("");
    try {
      await cancelRun.mutateAsync({ runId: run.id, stateVersion: run.stateVersion });
      setNotice("Cancellation requested. The terminal state appears only after durable shutdown and cleanup reconciliation.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "The run could not be canceled.");
    }
  }

  async function retryBuild() {
    if (!run) return;
    setNotice("");
    try {
      const retried = await retryRun.mutateAsync({ runId: run.id, stateVersion: run.stateVersion });
      setSelectedRunId(retried.id);
      setNotice("Retry queued with the same approved ProductSpec and fresh ephemeral sandboxes.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "The run could not be retried.");
    }
  }

  const actionPending = startRun.isPending || cancelRun.isPending || retryRun.isPending;
  const usage = run?.usage;
  const spentMicros = run?.actualCostMicros;
  const ceilingMicros = run?.budgetCeilingMicros ?? project.maxCostMicrosPerRun;
  const failedMessage = run && isLiveRun(run) ? run.failureMessage : null;
  const releasePending = Boolean(project.pendingApproval?.kind.includes("release"));
  const changedFiles = sourceArtifact?.fileCount ?? outputArtifact?.fileCount ?? (isDemo && run?.status === "succeeded" ? 18 : 0);

  return (
    <div className="content-stack build-room" aria-live="polite">
      {notice && <div className="inline-notice"><Icon name="shield" size={17} /><span>{notice}</span></div>}

      {!run && <>
        <div className="run-header"><div><span className="eyebrow">Pre-run review</span><h2>{project.spec?.status === "approved" ? "One approved specification. One bounded build." : "The build gate is still closed."}</h2><p>Review the immutable ProductSpec, usage scenario, fixed credit charge, hard provider-cost ceiling, and sandbox policy before starting.</p></div></div>
        {project.spec?.status !== "approved" ? <Surface className="build-state-panel build-preflight-blocked"><EmptyState icon="approval" title="Approve the ProductSpec first" description="A build cannot start from a draft or pending specification. The approval binds the exact ProductSpec hash used by the builder." action={<ButtonLink href={project.pendingApproval ? "/approvals" : `/projects/${project.id}/spec`} icon="arrow-right">{project.pendingApproval ? "Review approval" : "Review ProductSpec"}</ButtonLink>} /></Surface> : <Surface className="build-state-panel build-preflight">
          <div className="build-state-heading"><div><span className="eyebrow">Approved input</span><h2>{project.spec.title}</h2><p>{project.spec.oneLiner}</p></div><StatusBadge tone="success">Approved v{project.spec.version}</StatusBadge></div>
          <dl className="preflight-spec"><div><dt>ProductSpec hash</dt><dd><code title={project.spec.hash}>{shortHash(project.spec.hash)}</code></dd></div><div><dt>Target user</dt><dd>{project.spec.targetUser}</dd></div></dl>
          <div className="preflight-grid">
            <div><small>Estimated tokens</small><strong>{estimate ? `${formatTokens(estimate.expected.totalTokens)} expected` : estimateQuery.isPending ? "Calculating…" : "Unavailable"}</strong><span>{estimate ? `${formatTokens(estimate.low.totalTokens)}–${formatTokens(estimate.high.totalTokens)} scenario` : "Scenario, never a hard bound"}</span></div>
            <div><small>Estimated provider cost</small><strong>{estimate ? estimate.providerCostMicros.ratesConfigured ? formatMoney(estimate.providerCostMicros.expected) : "Rates unavailable" : "—"}</strong><span>{estimate ? estimate.providerCostMicros.ratesConfigured ? `${formatMoney(estimate.providerCostMicros.low)}–${formatMoney(estimate.providerCostMicros.high)}` : "Configure provider rates before treating cost as a forecast" : "Current configured rates"}</span></div>
            <div><small>Exact customer charge</small><strong>{estimate ? `${estimate.creditQuote.credits} credits` : "—"}</strong><span>Fixed product pricing · not token conversion</span></div>
            <div><small>Authorized provider ceiling</small><strong>{formatMoney(project.maxCostMicrosPerRun)}</strong><span>Hard stop for provider calls</span></div>
            <div><small>Model turns</small><strong>20 maximum</strong><span>Includes up to 2 verifier repair passes</span></div>
            <div><small>Sandbox policy</small><strong>Builder + fresh verifier</strong><span>No network, provider credentials, or project secrets · ephemeral auto-delete</span></div>
          </div>
          {estimateQuery.isError && <div className="inline-error" role="alert"><Icon name="warning" size={17} />{estimateQuery.error instanceof Error ? estimateQuery.error.message : "The build estimate is unavailable."}</div>}
          <div className="preflight-action"><p>Starting reserves the exact credit quote and provider ceiling. Production remains unchanged until release approval.</p><label className="form-field compact-field"><span>Model for this build</span><select aria-label="Model for this build" value={model} onChange={(event) => setModel(event.target.value as WorkflowModel)}>{WorkflowModelOptions.map((option) => <option key={option.id} value={option.id}>{option.label} — {option.description}</option>)}</select></label><Button kind="primary" icon="terminal" disabled={actionPending || estimateQuery.isPending} onClick={() => void startBuild()}>{startRun.isPending ? "Starting build…" : "Start build"}</Button></div>
        </Surface>}
      </>}

      {run && active && <>
        <div className="run-header"><div><span className="eyebrow">Running build · {run.id.slice(0, 12)}</span><h2>{currentStep}</h2><p>The current stage is durable. Actual provider usage is recorded independently from the fixed customer credit charge.</p></div><Button disabled={actionPending || run.status === "cancel_requested"} icon="pause" onClick={() => void cancelBuild()}>{run.status === "cancel_requested" ? "Cancel requested" : cancelRun.isPending ? "Requesting cancel…" : "Cancel build"}</Button></div>
        <div className="metric-grid four-col">
          <Metric detail="Current durable stage" label="Stage" tone="info" value={currentStep} />
          <Metric detail="30 minute shared deadline" label="Elapsed" value={formatDuration(run.startedAt, null, now)} />
          <Metric detail={`${formatTokens(usage?.inputTokens)} input · ${formatTokens(usage?.outputTokens)} output`} label="Actual tokens" value={formatTokens(usage?.totalTokens)} />
          <Metric detail={`${formatMoney(ceilingMicros)} hard ceiling`} label="Actual provider cost" value={formatMoney(spentMicros)} />
        </div>
        <Surface className="build-state-panel running-stage"><div><span className="running-pulse" aria-hidden="true" /><p><small>Now executing</small><strong>{currentStep}</strong><span>{run.status === "cancel_requested" ? "Waiting for durable shutdown and cleanup reconciliation." : "Polling canonical run state every two seconds."}</span></p></div><StatusBadge tone="info">{run.status.replaceAll("_", " ")}</StatusBadge></Surface>
        <RunDetails logLines={logLines} run={run} timeline={timeline} />
      </>}

      {run?.status === "succeeded" && <>
        {isDemo && <div className="mode-banner"><StatusBadge tone="info">Simulation</StatusBadge><div><strong>Demo verification data</strong><p>No external sandbox, repository, or deployment was created. Live mode renders only persisted provider results.</p></div></div>}
        <Surface className="signed-preview-card">
          <div><span className="eyebrow">Signed preview</span><h2>Inspect the verified build before release.</h2><p>{run.previewUrl ? "This short-lived URL is bound to the signed artifact hashes below." : "Verification passed, but no signed preview URL is currently available."}</p></div>
          <Button kind="primary" disabled={!run.previewUrl} icon="eye" onClick={() => run.previewUrl && window.open(run.previewUrl, "_blank", "noopener,noreferrer")}>Open signed preview</Button>
        </Surface>

        <Surface className="verification-table-wrap">
          <div className="surface-head"><div><span className="eyebrow">Clean verifier sandbox</span><h2>Verification passed</h2><p>{verification ? `Verifier ${verification.verifierImage} · report ${shortHash(verification.reportHash)}` : isDemo ? "Simulated verifier report." : "The signed verifier report is unavailable."}</p></div><StatusBadge tone={resolvedGates.length && resolvedGates.every((gate) => gate.status === "passed") ? "success" : "neutral"}>{resolvedGates.filter((gate) => gate.status === "passed").length} gates passed</StatusBadge></div>
          <div className="verification-table" role="table" aria-label="Verification checks">{resolvedGates.length ? resolvedGates.map((gate) => <div role="row" key={gate.name}><span role="cell"><Icon name={gate.status === "passed" ? "check" : "warning"} size={16} /></span><strong role="cell">{gate.name.replaceAll("_", " ")}</strong><span role="cell">{gate.summary}</span><StatusBadge tone={gate.status === "passed" ? "success" : gate.status === "failed" ? "danger" : "neutral"}>{gate.status}</StatusBadge></div>) : <p className="empty-copy">No verifier gates are available.</p>}</div>
        </Surface>

        <Surface className="changed-files-panel"><div><span className="eyebrow">Changed files</span><h2>{changedFiles ? `${changedFiles} allowlisted file${changedFiles === 1 ? "" : "s"}` : "Manifest unavailable"}</h2><p>The release source is content-addressed. Only files in the verified repository manifest can move to release approval.</p></div><Icon name="file" size={25} /></Surface>

        <div className="metric-grid four-col">
          <Metric detail={`${formatTokens(usage?.inputTokens)} input · ${formatTokens(usage?.outputTokens)} output`} label="Actual tokens" value={formatTokens(usage?.totalTokens)} />
          <Metric detail={`${usage?.providerCalls ?? 0} provider call${usage?.providerCalls === 1 ? "" : "s"}`} label="Actual provider cost" value={formatMoney(usage?.costMicros ?? spentMicros)} />
          <Metric detail={`${formatMoney(ceilingMicros)} authorized ceiling`} label="Recorded run cost" value={formatMoney(spentMicros)} />
          <Metric detail="Builder + clean verifier" label="Elapsed" tone="success" value={formatDuration(run.startedAt, run.finishedAt)} />
        </div>

        <Surface className="release-next-action"><div><span className="eyebrow">Release gate</span><h2>{releasePending ? "Owner approval is required." : "Release approval is being reconciled."}</h2><p>Repository and deployment effects remain blocked until the signed preview, specification hash, artifact hash, provider accounts, and cost ceiling are approved together.</p></div><ButtonLink href={releasePending ? "/approvals" : `/projects/${project.id}/releases`} icon="approval">{releasePending ? "Review release approval" : "View release state"}</ButtonLink></Surface>

        <details className="artifact-details"><summary>Artifact hashes and technical logs</summary><div className="artifact-detail-grid"><dl><div><dt>Artifact hash</dt><dd><code title={outputArtifact?.artifactHash ?? run.artifactHash ?? undefined}>{shortHash(outputArtifact?.artifactHash ?? run.artifactHash)}</code></dd></div><div><dt>Manifest hash</dt><dd><code title={outputArtifact?.manifestHash}>{shortHash(outputArtifact?.manifestHash)}</code></dd></div><div><dt>Verification report</dt><dd><code title={verification?.reportHash}>{shortHash(verification?.reportHash)}</code></dd></div></dl><RunDetails logLines={logLines} run={run} timeline={timeline} /></div></details>
      </>}

      {run?.status === "failed" && <>
        <div className="run-header"><div><span className="eyebrow">Build failed · {run.id.slice(0, 12)}</span><h2>Stopped during {readableStage(run.currentStepKey)}.</h2><p>{failedMessage ?? "The durable run stopped before a verified artifact could be approved."}</p></div></div>
        <div className="metric-grid four-col">
          <Metric detail="Last durable checkpoint" label="Failed stage" tone="danger" value={readableStage(run.currentStepKey)} />
          <Metric detail="Ephemeral sandboxes are never reused" label="Cleanup policy" value="Fresh retry" />
          <Metric detail={`${formatTokens(usage?.inputTokens)} input · ${formatTokens(usage?.outputTokens)} output`} label="Consumed tokens" value={formatTokens(usage?.totalTokens)} />
          <Metric detail={`${formatMoney(ceilingMicros)} ceiling`} label="Consumed provider cost" value={formatMoney(usage?.costMicros ?? spentMicros)} />
        </div>
        <Surface className="retry-panel"><div><span className="eyebrow">Retry reuse</span><h2>Reuse the approved ProductSpec, not the failed sandbox.</h2><p>Retry remains bound to ProductSpec <code>{shortHash(project.spec?.hash)}</code>, retained evidence, and the same provider ceiling. It creates a fresh credit reservation and fresh builder/verifier sandboxes.</p></div><Button kind="primary" disabled={actionPending} icon="retry" onClick={() => void retryBuild()}>{retryRun.isPending ? "Queuing retry…" : "Retry build"}</Button></Surface>
        <RunDetails logLines={logLines} run={run} timeline={timeline} />
      </>}

      {run?.status === "canceled" && <>
        <div className="run-header"><div><span className="eyebrow">Build canceled · {run.id.slice(0, 12)}</span><h2>The run is terminal and production is unchanged.</h2><p>A new attempt will reuse only the approved ProductSpec and retained evidence. It will not reuse canceled sandboxes or a prior budget reservation.</p></div></div>
        <div className="metric-grid four-col">
          <Metric detail="Durable terminal state" label="Run state" tone="neutral" value="Canceled" />
          <Metric detail="Fresh ephemeral sandboxes on retry" label="Cleanup policy" value="No reuse" />
          <Metric detail={`${formatTokens(usage?.inputTokens)} input · ${formatTokens(usage?.outputTokens)} output`} label="Consumed tokens" value={formatTokens(usage?.totalTokens)} />
          <Metric detail={`${formatMoney(ceilingMicros)} ceiling`} label="Consumed provider cost" value={formatMoney(usage?.costMicros ?? spentMicros)} />
        </div>
        <Surface className="retry-panel"><div><span className="eyebrow">Start again safely</span><h2>Retry from the same approved ProductSpec.</h2><p>The retry endpoint validates the prior terminal state and creates a fresh attempt with new reservations.</p></div><Button kind="primary" disabled={actionPending} icon="retry" onClick={() => void retryBuild()}>{retryRun.isPending ? "Queuing retry…" : "Retry canceled build"}</Button></Surface>
        <RunDetails logLines={logLines} run={run} timeline={timeline} />
      </>}
    </div>
  );
}
