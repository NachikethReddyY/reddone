"use client";

import Link from "next/link";

import { Icon, type IconName } from "@/components/icons";
import { Button, ButtonLink, EmptyState, Metric, SectionHeading, Skeleton, StatusBadge, Surface } from "@/components/ui";
import { useProjectQuery } from "@/features/projects/project-queries";
import { FindingSpecAction } from "./finding-spec-action";
import { ProjectRunActions } from "./project-run-actions";
import {
  formatCompactDate,
  formatExpiry,
  formatMoneyMicros,
  projectLifecycleFor,
  type ProjectViewModel,
} from "./project-view-data";

function isStatus(project: ProjectViewModel, ...values: string[]) {
  return values.includes(project.status);
}

function runActivities(project: ProjectViewModel) {
  const stepActivities = project.runs
    .flatMap((run) => run.steps.map((step) => ({
      id: `${run.id}-${step.id}`,
      title: step.label,
      detail: `${run.kind} run · ${step.status.replaceAll("_", " ")}`,
      time: activityTime(step.updatedAt),
      tone: step.status === "succeeded" ? "success" : step.status === "failed" ? "warning" : "info",
    })))
    .slice(-4)
    .reverse();
  if (stepActivities.length) return stepActivities;
  return [
    project.deployment ? { id: "deployment", title: "Deployment recorded", detail: `${project.deployment.health} · ${project.deployment.url}`, time: activityTime(project.updatedAt), tone: project.deployment.health === "healthy" ? "success" : "warning" } : null,
    project.repository ? { id: "repository", title: "Private repository bound", detail: project.repository.fullName, time: activityTime(project.updatedAt), tone: "success" } : null,
    project.spec ? { id: "spec", title: `ProductSpec v${project.spec.version} ${project.spec.status.replaceAll("_", " ")}`, detail: project.spec.oneLiner, time: activityTime(project.spec.updatedAt), tone: project.spec.status === "approved" ? "success" : "info" } : null,
    project.findings.length ? { id: "evidence", title: `${project.findings.length} findings ranked`, detail: `${project.findings.reduce((sum, finding) => sum + finding.evidence.length, 0)} retained evidence excerpts`, time: activityTime(project.updatedAt), tone: "success" } : null,
  ].filter((item): item is NonNullable<typeof item> => item !== null);
}

function OverviewLoading() {
  return (
    <div aria-busy="true" aria-label="Loading project overview" className="project-view-loading" role="status">
      <Surface className="decision-banner"><Skeleton className="loading-icon" /><div><Skeleton className="loading-kicker" /><Skeleton className="loading-title" /><Skeleton className="loading-copy" /></div></Surface>
      <div className="metric-grid four-col">{Array.from({ length: 4 }, (_, index) => <div className="metric" key={index}><Skeleton className="loading-kicker" /><Skeleton className="loading-metric" /><Skeleton className="loading-copy" /></div>)}</div>
      <Surface className="pipeline-surface"><Skeleton className="loading-title" /><Skeleton className="loading-panel" /></Surface>
    </div>
  );
}

function activityTime(value: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(date);
}

function stageIcon(stage: ReturnType<typeof projectLifecycleFor>["current"]["id"]): IconName {
  if (stage === "research" || stage === "select") return "database";
  if (stage === "specify" || stage === "approve-spec") return "file";
  if (stage === "build") return "terminal";
  if (stage === "release") return "approval";
  return "settings";
}

export function OverviewView({ projectId }: { projectId: string }) {
  const projectQuery = useProjectQuery(projectId);
  if (projectQuery.isPending) return <OverviewLoading />;
  if (!projectQuery.data) {
    const message = projectQuery.error instanceof Error ? projectQuery.error.message : "The project overview is unavailable.";
    return <EmptyState icon="warning" title="Overview unavailable" description={`${message} No project data was replaced or inferred.`} action={<Button icon="retry" onClick={() => void projectQuery.refetch()}>Retry loading</Button>} />;
  }

  const project = projectQuery.data;
  const lifecycle = projectLifecycleFor(project);
  const topFinding = project.selectedFinding ?? project.findings[0] ?? null;
  const evidenceCount = project.findings.reduce((sum, finding) => sum + finding.evidence.length, 0);
  const buildRun = project.runs.find((run) => run.kind === "build" || run.kind === "polish");
  const verificationPassed = buildRun?.status === "succeeded" || isStatus(project, "awaiting_release_approval", "released", "live");
  const activities = runActivities(project);
  const pendingRelease = Boolean(project.pendingApproval?.kind.includes("release"));

  return (
    <div className="content-stack">
      <Surface className={`decision-banner decision-banner-${lifecycle.current.id === "release" && isStatus(project, "released", "live") ? "success" : project.pendingApproval ? "warning" : "info"}`}>
        <span className="decision-glyph"><Icon name={stageIcon(lifecycle.current.id)} size={25} /></span>
        <div><span className="eyebrow">Current stage · {lifecycle.current.label}</span><h2>{lifecycle.blocker}</h2><p>{lifecycle.current.summary}</p></div>
        <div className="decision-meta">
          <span><small>{project.pendingApproval ? "Approval ceiling" : "Project state"}</small><strong>{project.pendingApproval ? formatMoneyMicros(project.pendingApproval.costCeilingMicros) : project.status.replaceAll("_", " ")}</strong></span>
          <span><small>{project.pendingApproval ? "Expires" : "Updated"}</small><strong>{project.pendingApproval ? formatExpiry(project.pendingApproval.expiresAt) : formatCompactDate(project.updatedAt)}</strong></span>
        </div>
        {lifecycle.primaryAction.kind === "research" && lifecycle.primaryAction.label === "Run research"
          ? <ProjectRunActions maxCostMicrosPerRun={project.maxCostMicrosPerRun} optimisticVersion={project.optimisticVersion} projectId={project.id} onQueued={() => void projectQuery.refetch()} />
          : lifecycle.primaryAction.kind === "generate-spec" && project.selectedFinding && !project.spec
            ? <FindingSpecAction project={project} onQueued={() => void projectQuery.refetch()} />
            : <ButtonLink href={lifecycle.primaryAction.href} kind="primary" icon="arrow-right">{lifecycle.primaryAction.label}</ButtonLink>}
      </Surface>

      <div className="metric-grid four-col">
        <Metric detail={`${project.findings.length} ranked finding${project.findings.length === 1 ? "" : "s"}`} label="Evidence excerpts" tone="info" value={String(evidenceCount)} />
        <Metric detail={topFinding ? "selected problem signal" : "research has not ranked a problem"} label="Top confidence" tone={topFinding ? "success" : "neutral"} value={topFinding ? `${Math.round(topFinding.score * 10)}%` : "—"} />
        <Metric detail={project.spec ? project.spec.status.replaceAll("_", " ") : "not generated"} label="ProductSpec" value={project.spec ? `v${project.spec.version}` : "—"} />
        <Metric detail={buildRun ? `${buildRun.status.replaceAll("_", " ")} build` : "no build run recorded"} label="Verification" tone={verificationPassed ? "success" : "neutral"} value={verificationPassed ? "Passed" : "Not run"} />
      </div>

      <Surface className="pipeline-surface lifecycle-surface">
        <SectionHeading eyebrow="Canonical lifecycle" title="Define → research → evidence → spec → build → release" description="Only the current stage expands. Completed stages remain links so you can inspect the durable record without losing the next action." />
        <ol className="lifecycle-list">
          {lifecycle.stages.map((stage, index) => {
            const content = <><span className="pipeline-index">{stage.state === "complete" ? <Icon name="check" size={15} /> : String(index + 1).padStart(2, "0")}</span><div><strong>{stage.label}</strong>{stage.state === "current" && <><p>{stage.summary}</p><small>{lifecycle.blocker}</small></>}</div>{stage.state === "complete" && <Icon name="arrow-right" size={15} />}</>;
            return <li className={`lifecycle-stage is-${stage.state}`} key={stage.id}>{stage.state === "complete" ? <Link href={stage.href}>{content}</Link> : <div aria-current={stage.state === "current" ? "step" : undefined}>{content}</div>}</li>;
          })}
        </ol>
      </Surface>

      <div className="overview-grid">
        <Surface className="finding-feature">
          <div className="surface-head"><div><span className="eyebrow">{project.selectedFinding ? "Selected evidence" : "Ranked evidence"}</span><h2>{project.selectedFinding ? "Problem worth building" : topFinding ? "Top-ranked candidate · selection required" : "No problem selected yet"}</h2></div><Link href={`/projects/${project.id}/evidence`}>{project.selectedFinding ? "View evidence" : "Choose a finding"} <Icon name="arrow-right" size={16} /></Link></div>
          {topFinding ? <>
            {topFinding.evidence[0] ? <blockquote>“{topFinding.evidence[0].quote}”</blockquote> : <div className="inline-notice"><Icon name="database" size={17} /><span>No retained excerpt is attached to this finding.</span></div>}
            {topFinding.evidence[0] && <div className="finding-source"><span><Icon name="database" size={16} />{topFinding.evidence[0].source}</span><span>{topFinding.evidence[0].attribution}</span></div>}
            <h3>{topFinding.title}</h3><p>{topFinding.summary}</p>
            <div className="score-strip" aria-label="Finding scores">{Object.entries(topFinding.scores).map(([label, score]) => <span key={label}><small>{label}</small><strong>{score}<i>/10</i></strong></span>)}</div>
          </> : <EmptyState icon="database" title="Research has not produced findings" description="Start a fixture research run or add an authorized import. Ranked, attributable evidence will appear here." />}
        </Surface>

        <Surface className="spec-snapshot">
          <div className="surface-head"><div><span className="eyebrow">{project.spec ? `ProductSpec v${project.spec.version}` : "ProductSpec"}</span><h2>{project.spec?.oneLiner ?? "No specification yet"}</h2></div><StatusBadge tone={project.spec?.status === "approved" ? "success" : project.spec ? "warning" : "neutral"}>{project.spec?.status.replaceAll("_", " ") ?? "Not created"}</StatusBadge></div>
          {project.spec ? <>
            <div className="spec-target"><Icon name="spark" size={20} /><span><small>For</small><strong>{project.spec.targetUser}</strong></span></div>
            {project.spec.workflow.length ? <ol className="workflow-list">{project.spec.workflow.slice(0, 4).map((item, index) => <li key={`${index}-${item}`}><span>{String(index + 1).padStart(2, "0")}</span>{item}</li>)}</ol> : <div className="inline-notice"><Icon name="file" size={17} /><span>The approved scope is available in the complete specification.</span></div>}
            <Link className="text-link" href={`/projects/${project.id}/spec`}>Read specification <Icon name="arrow-right" size={16} /></Link>
          </> : <EmptyState icon="file" title="Awaiting a specification" description="Research and finding selection must finish before a versioned ProductSpec can be reviewed." />}
        </Surface>
      </div>

      <div className="overview-grid reverse">
        <Surface className="activity-surface">
          <div className="surface-head"><div><span className="eyebrow">Audit-friendly activity</span><h2>Latest canonical changes</h2></div><Link href={`/projects/${project.id}/builds`}>Open builds <Icon name="arrow-right" size={16} /></Link></div>
          {activities.length ? <div className="activity-list">{activities.map((event) => <div className="activity-row" key={event.id}><time>{event.time}</time><span className={`activity-marker tone-${event.tone}`}><Icon name={event.tone === "success" ? "check" : event.tone === "warning" ? "warning" : "activity"} size={15} /></span><div><strong>{event.title}</strong><p>{event.detail}</p></div></div>)}</div> : <EmptyState icon="activity" title="No project activity yet" description="Research, approvals, builds, and release effects will add durable activity here." />}
        </Surface>

        <Surface className="system-snapshot">
          <span className="eyebrow">Execution boundary</span><h2>Project-owned resources</h2>
          <div className="system-list">
            <div><span><Icon name="database" size={18} /></span><p><strong>Research source</strong><small>{project.sourceLabel}</small></p><StatusBadge tone={project.sourceMode === "live" && !project.liveAuthorized ? "warning" : "success"}>{project.sourceMode === "live" && !project.liveAuthorized ? "Locked" : project.sourceMode}</StatusBadge></div>
            <div><span><Icon name="file" size={18} /></span><p><strong>ProductSpec</strong><small>{project.spec ? `v${project.spec.version} · ${project.spec.hash.slice(0, 12)}` : "Not created"}</small></p><StatusBadge tone={project.spec?.status === "approved" ? "success" : "neutral"}>{project.spec?.status.replaceAll("_", " ") ?? "Pending"}</StatusBadge></div>
            <div><span><Icon name="branch" size={18} /></span><p><strong>GitHub repository</strong><small>{project.repository?.fullName ?? "Not created"}</small></p><StatusBadge tone={project.repository ? "success" : "neutral"}>{project.repository?.visibility ?? "Awaiting"}</StatusBadge></div>
            <div><span><Icon name="globe" size={18} /></span><p><strong>Deployment</strong><small>{project.deployment?.url ?? "Production unchanged"}</small></p><StatusBadge tone={project.deployment?.health === "healthy" ? "success" : project.deployment ? "warning" : "neutral"}>{project.deployment?.health ?? "Not deployed"}</StatusBadge></div>
          </div>
          {pendingRelease && <ButtonLink href="/approvals" icon="approval">Review release approval</ButtonLink>}
        </Surface>
      </div>
    </div>
  );
}
