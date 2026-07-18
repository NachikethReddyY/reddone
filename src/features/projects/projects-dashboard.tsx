"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { Icon } from "@/components/icons";
import { EmptyState, Progress, SourceBadge, StatusBadge, Surface } from "@/components/ui";
import type { DemoProject, ProjectStatus } from "@/demo-data/control-plane";
import { CreateProjectButton } from "./create-project-dialog";

const statusMeta = {
  researching: { label: "Researching", tone: "info" as const },
  "spec-review": { label: "Spec review", tone: "warning" as const },
  building: { label: "Building", tone: "info" as const },
  "release-ready": { label: "Release ready", tone: "warning" as const },
  live: { label: "Live", tone: "success" as const },
  paused: { label: "Paused", tone: "neutral" as const },
};

type ApiProject = {
  id: string;
  name: string;
  marketLabel?: string;
  latestEvidenceSummary?: string | null;
  status?: string;
  sourceMode?: string;
  researchMode?: string;
  sourceLabel?: string;
  blocker?: string | null;
  currentBlocker?: string | null;
  nextAction?: string;
  findings?: unknown[];
  updatedAt?: string;
  latestRunStatus?: string | null;
  liveUrl?: string | null;
};

function uiStatus(value?: string): ProjectStatus {
  const status = value?.toLowerCase();
  if (status === "released" || status === "live") return "live";
  if (status === "building") return "building";
  if (status === "ready_to_build" || status === "release_ready" || status === "awaiting_release_approval") return "release-ready";
  if (status === "awaiting_spec_approval" || status === "needs_approval") return "spec-review";
  if (status === "paused") return "paused";
  return "researching";
}

function normalizeProject(record: ApiProject): DemoProject {
  const status = uiStatus(record.status);
  const source = (record.researchMode ?? record.sourceMode ?? "fixture").toLowerCase();
  const progress = status === "live" ? 100 : status === "release-ready" ? 82 : status === "building" ? 68 : status === "spec-review" ? 52 : 24;
  return {
    id: record.id,
    name: record.name,
    oneLiner: record.latestEvidenceSummary ?? record.marketLabel ?? "Evidence-first product workspace",
    status,
    stageLabel: statusMeta[status].label,
    progress,
    blocker: record.currentBlocker ?? record.blocker ?? "No active blocker",
    nextAction: record.nextAction ?? "Open project",
    sourceMode: source.includes("import") ? "import" : source.includes("reddit") ? "live" : "fixture",
    communities: record.sourceLabel ? [record.sourceLabel] : [],
    findingCount: record.findings?.length ?? 0,
    evidenceDelta: 0,
    sandbox: record.latestRunStatus === "succeeded" ? "Verified" : "Not created",
    repository: "Private only",
    deployment: record.liveUrl ? "Healthy" : "Not deployed",
    nextResearch: "Off",
    nextPolish: "Off",
    updatedAt: record.updatedAt ? new Date(record.updatedAt).toLocaleString() : "just now",
  };
}

export function ProjectsDashboard() {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [projectRecords, setProjectRecords] = useState<DemoProject[]>([]);
  const [loadNotice, setLoadNotice] = useState("");
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let active = true;
    fetch("/api/v1/projects", { headers: { accept: "application/json" } })
      .then(async (response) => {
        const body = await response.json() as { data?: { items?: ApiProject[] }; error?: { message?: string } };
        if (!response.ok) throw new Error(body.error?.message ?? "Projects are unavailable.");
        return body.data?.items ?? [];
      })
      .then((items) => { if (active) setProjectRecords(items.map(normalizeProject)); })
      .catch((error: unknown) => { if (active) setLoadNotice(error instanceof Error ? error.message : "Projects are unavailable."); })
      .finally(() => { if (active) setLoaded(true); });
    return () => { active = false; };
  }, []);

  const filtered = useMemo(() => projectRecords.filter((project) => {
    const matchesQuery = `${project.name} ${project.oneLiner} ${project.communities.join(" ")}`.toLowerCase().includes(query.toLowerCase());
    const matchesFilter = filter === "all" || project.status === filter;
    return matchesQuery && matchesFilter;
  }), [filter, projectRecords, query]);
  const decisionProjects = projectRecords.filter((project) => project.status === "spec-review" || project.status === "release-ready");

  return (
    <>
      <div className="dashboard-brief">
        <div>
          <span className="brief-signal"><span /> Attention queue</span>
          <h2>{decisionProjects.length || "No"} {decisionProjects.length === 1 ? "decision is" : "decisions are"} holding the line.</h2>
          <p>{decisionProjects.length ? decisionProjects.map((project) => `${project.name}: ${project.blocker}`).join(" · ") : "No project is waiting for an owner decision."}</p>
        </div>
        <Link className="brief-action" href="/approvals">
          <span><strong>{decisionProjects.length}</strong><small>pending approvals</small></span>
          <Icon name="arrow-right" size={22} />
        </Link>
      </div>

      <div className="project-toolbar">
        <label className="search-field">
          <span className="sr-only">Search projects</span>
          <Icon name="search" size={18} />
          <input placeholder="Search projects, sources, or stages" type="search" value={query} onChange={(event) => setQuery(event.target.value)} />
          {query && <button aria-label="Clear project search" onClick={() => setQuery("")}><Icon name="close" size={16} /></button>}
        </label>
        <label className="select-field compact-select">
          <span className="sr-only">Filter project status</span>
          <Icon name="filter" size={17} />
          <select value={filter} onChange={(event) => setFilter(event.target.value)}>
            <option value="all">All states</option>
            <option value="researching">Researching</option>
            <option value="spec-review">Spec review</option>
            <option value="release-ready">Release ready</option>
            <option value="live">Live</option>
          </select>
          <Icon name="chevron-down" size={15} />
        </label>
      </div>

      {loadNotice && <div className="inline-notice" role="alert"><Icon name="warning" size={17} /><span>{loadNotice} No project state was inferred or replaced.</span></div>}

      {!loaded ? <div aria-busy="true" className="inline-notice" role="status"><Icon name="activity" size={17} /><span>Loading workspace projects…</span></div> : filtered.length ? (
        <div className="project-grid">
          {filtered.map((project, index) => {
            const status = statusMeta[project.status];
            return (
              <Surface className="project-card reveal" key={project.id} style={{ animationDelay: `${index * 55}ms` }}>
                <div className="project-card-top">
                  <div className="project-mark" aria-hidden="true"><span>{String(index + 1).padStart(2, "0")}</span>{project.name.split(" ").map((part) => part[0]).join("").slice(0, 2)}</div>
                  <div className="project-card-status"><StatusBadge tone={status.tone} pulse={project.status === "researching"}>{status.label}</StatusBadge><SourceBadge mode={project.sourceMode} /></div>
                </div>
                <div className="project-card-copy">
                  <Link href={`/projects/${project.id}`}><h3>{project.name}</h3></Link>
                  <p>{project.oneLiner}</p>
                </div>
                <div className="community-list" aria-label="Research communities">
                  {project.communities.map((community) => <span key={community}>{community}</span>)}
                </div>
                <Progress label={project.stageLabel} value={project.progress} />
                <div className="project-facts">
                  <div><span>Latest evidence</span><strong>{project.findingCount} findings <em>+{project.evidenceDelta}</em></strong></div>
                  <div><span>Sandbox</span><strong>{project.sandbox}</strong></div>
                  <div><span>Next research</span><strong>{project.nextResearch}</strong></div>
                </div>
                <div className="project-blocker">
                  <Icon name={project.status === "release-ready" || project.status === "spec-review" ? "warning" : "clock"} size={18} />
                  <span><small>Current blocker</small><strong>{project.blocker}</strong></span>
                </div>
                <div className="project-card-footer">
                  <span>Updated {project.updatedAt}</span>
                  <Link href={`/projects/${project.id}`}><span>{project.nextAction}</span><Icon name="arrow-right" size={17} /></Link>
                </div>
              </Surface>
            );
          })}
        </div>
      ) : (
        <EmptyState icon={loadNotice ? "warning" : "search"} title={loadNotice ? "Projects unavailable" : projectRecords.length ? "No projects match" : "No projects yet"} description={loadNotice ? "Retry after the canonical API is available." : projectRecords.length ? "Try another name or clear the status filter to see the full workspace." : "Create an evidence-first project to begin."} action={loadNotice ? <button className="button button-secondary" onClick={() => window.location.reload()}>Retry</button> : projectRecords.length ? <button className="button button-secondary" onClick={() => { setQuery(""); setFilter("all"); }}>Clear filters</button> : <CreateProjectButton />} />
      )}

      <div className="first-run-card">
        <span className="first-run-icon"><Icon name="spark" size={22} /></span>
        <div><strong>Want a clean first-run state?</strong><p>The New Project flow includes fixture and import paths, so you can prove the product without live Reddit access.</p></div>
        <CreateProjectButton />
      </div>
    </>
  );
}
