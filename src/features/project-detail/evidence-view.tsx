"use client";

import { useEffect, useMemo, useState } from "react";

import { Icon } from "@/components/icons";
import { Button, EmptyState, Skeleton, SourceBadge, StatusBadge, Surface } from "@/components/ui";
import { FindingSpecAction } from "./finding-spec-action";
import { readProjectView, type ProjectFindingView, type ProjectViewModel } from "./project-view-data";

function evidenceMode(project: ProjectViewModel) {
  if (project.sourceMode === "live" && !project.liveAuthorized) {
    return {
      badge: <StatusBadge tone="warning">Live Reddit locked</StatusBadge>,
      title: "Written authorization is not recorded",
      detail: "Live calls remain disabled. Use a fixture or an authorized JSON import while approval is pending.",
    };
  }
  if (project.sourceMode === "live") {
    return {
      badge: <SourceBadge mode="live" />,
      title: "Approved live source",
      detail: `${project.sourceLabel}. Attribution and retained excerpts come from the canonical project record.`,
    };
  }
  if (project.sourceMode === "import") {
    return {
      badge: <SourceBadge mode="import" />,
      title: "Authorized import mode",
      detail: `${project.sourceLabel}. Imported content was schema-validated before research.`,
    };
  }
  return {
    badge: <SourceBadge mode="fixture" />,
    title: "Curated fixture mode",
    detail: `${project.sourceLabel}. No live Reddit API calls are being made.`,
  };
}

function EvidenceLoading() {
  return (
    <div aria-busy="true" aria-label="Loading project evidence" className="project-view-loading" role="status">
      <div className="mode-banner"><Skeleton className="loading-badge" /><div><Skeleton className="loading-kicker" /><Skeleton className="loading-copy" /></div></div>
      <Surface className="evidence-explainer"><div><Skeleton className="loading-kicker" /><Skeleton className="loading-title" /><Skeleton className="loading-copy" /></div><Skeleton className="loading-panel compact" /></Surface>
      {Array.from({ length: 2 }, (_, index) => <div className="evidence-card evidence-card-loading" key={index}><Skeleton className="loading-metric" /><div><Skeleton className="loading-title" /><Skeleton className="loading-copy" /><Skeleton className="loading-panel compact" /></div><Skeleton className="loading-panel" /></div>)}
    </div>
  );
}

function firstEvidence(finding: ProjectFindingView) {
  return finding.evidence[0] ?? null;
}

export function EvidenceView({ projectId }: { projectId: string }) {
  const [project, setProject] = useState<ProjectViewModel | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState("rank");
  const [error, setError] = useState("");
  const [decisionMessage, setDecisionMessage] = useState("");
  const [decisionFailed, setDecisionFailed] = useState(false);
  const [choosing, setChoosing] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/v1/projects/${projectId}`, { headers: { accept: "application/json" }, signal: controller.signal })
      .then((response) => readProjectView(response, projectId))
      .then((nextProject) => {
        setError("");
        setProject(nextProject);
        setSelected((current) => current.length ? current.filter((id) => nextProject.findings.some((finding) => finding.id === id)).slice(0, 2) : nextProject.selectedFinding ? [nextProject.selectedFinding.id] : []);
      })
      .catch((caught: unknown) => {
        if (!controller.signal.aborted) setError(caught instanceof Error ? caught.message : "Project evidence is unavailable.");
      });
    return () => controller.abort();
  }, [projectId, reload]);

  const visible = useMemo(() => {
    if (!project) return [];
    const normalizedQuery = query.trim().toLowerCase();
    const items = project.findings.filter((finding) => {
      const evidenceText = finding.evidence.map((item) => `${item.quote} ${item.source} ${item.attribution}`).join(" ");
      return `${finding.title} ${finding.summary} ${evidenceText}`.toLowerCase().includes(normalizedQuery);
    });
    if (sort === "urgency") return [...items].sort((a, b) => b.scores.urgency - a.scores.urgency);
    if (sort === "frequency") return [...items].sort((a, b) => b.scores.frequency - a.scores.frequency);
    if (sort === "confidence") return [...items].sort((a, b) => b.score - a.score);
    return [...items].sort((a, b) => a.rank - b.rank);
  }, [project, query, sort]);

  function toggle(id: string) {
    setSelected((current) => {
      if (current.includes(id)) return current.filter((item) => item !== id);
      if (current.length < 2) return [...current, id];
      const comparisonAnchor = current[1] ?? current[0];
      return comparisonAnchor ? [comparisonAnchor, id] : [id];
    });
  }

  async function chooseFinding(finding: ProjectFindingView) {
    setChoosing(finding.id);
    setDecisionFailed(false);
    setDecisionMessage(`Selecting “${finding.title}” as the ProductSpec basis…`);
    try {
      const response = await fetch(`/api/v1/projects/${project!.id}/findings/${finding.id}/select`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": `finding-select-${crypto.randomUUID()}`,
          "if-match": `"${project!.optimisticVersion}"`,
        },
        body: JSON.stringify({}),
      });
      const body = await response.json().catch(() => null) as { error?: { message?: string } } | null;
      if (!response.ok) throw new Error(body?.error?.message ?? `Finding selection failed (${response.status}).`);
      setDecisionMessage("Finding selected. Review it once more, then queue ProductSpec generation.");
      setReload((value) => value + 1);
    } catch (caught) {
      setDecisionFailed(true);
      setDecisionMessage(caught instanceof Error ? caught.message : "The finding could not be selected.");
    } finally {
      setChoosing(null);
    }
  }

  if (!project && !error) return <EvidenceLoading />;
  if (!project) {
    return <EmptyState icon="warning" title="Evidence unavailable" description={`${error} No source data was replaced or inferred.`} action={<Button icon="retry" onClick={() => { setError(""); setReload((value) => value + 1); }}>Retry loading</Button>} />;
  }

  const mode = evidenceMode(project);
  const evidenceCount = project.findings.reduce((sum, finding) => sum + finding.evidence.length, 0);
  const selectedFindingCount = project.findings.filter((finding) => finding.selected).length;

  return (
    <div className="content-stack">
      <div className="mode-banner">{mode.badge}<div><strong>{mode.title}</strong><p>{mode.detail}</p></div></div>

      <Surface className="evidence-explainer">
        <div><span className="eyebrow">Selection lens</span><h2>Evidence before enthusiasm.</h2><p>ReDDone ranks repeated pain by frequency, urgency, willingness to pay, and buildability. Each excerpt remains linked to its minimal retained source record.</p></div>
        <div className="evidence-method"><span><strong>{evidenceCount}</strong><small>retained excerpts</small></span><Icon name="arrow-right" size={19} /><span><strong>{project.findings.length}</strong><small>ranked findings</small></span><Icon name="arrow-right" size={19} /><span><strong>{selectedFindingCount}</strong><small>specification basis</small></span></div>
      </Surface>

      {decisionMessage && <div aria-live="polite" className={decisionFailed ? "inline-notice is-error" : "inline-notice"} role={decisionFailed ? "alert" : "status"}><Icon name={decisionFailed ? "warning" : "check"} size={17} /><span>{decisionMessage}</span></div>}

      {project.selectedFinding && !project.spec && (
        <Surface className="selection-gate">
          <div><span className="eyebrow">Selected ProductSpec basis</span><h3>{project.selectedFinding.title}</h3><p>The provider call remains deferred until you explicitly queue this versioned workflow.</p></div>
          <FindingSpecAction project={project} onQueued={() => setReload((value) => value + 1)} />
        </Surface>
      )}

      {project.findings.length ? <>
        <div className="evidence-toolbar">
          <label className="search-field"><span className="sr-only">Search findings</span><Icon name="search" size={18} /><input placeholder="Search pain, evidence, or source" type="search" value={query} onChange={(event) => setQuery(event.target.value)} />{query && <button aria-label="Clear evidence search" onClick={() => setQuery("")}><Icon name="close" size={16} /></button>}</label>
          <label className="select-field compact-select"><span className="sr-only">Sort findings</span><select value={sort} onChange={(event) => setSort(event.target.value)}><option value="rank">Overall rank</option><option value="confidence">Highest confidence</option><option value="urgency">Highest urgency</option><option value="frequency">Highest frequency</option></select><Icon name="chevron-down" size={15} /></label>
          <span className="compare-count" aria-live="polite">{selected.length}/2 selected to compare</span>
        </div>

        {visible.length ? <div className="finding-list">
          {visible.map((finding) => {
            const evidence = firstEvidence(finding);
            return (
              <article className={`evidence-card ${selected.includes(finding.id) ? "is-selected" : ""}`} key={finding.id}>
                <button aria-pressed={selected.includes(finding.id)} aria-label={`${selected.includes(finding.id) ? "Remove" : "Add"} ${finding.title} ${selected.includes(finding.id) ? "from" : "to"} comparison`} className="evidence-select" onClick={() => toggle(finding.id)}><span>{selected.includes(finding.id) ? <Icon name="check" size={16} /> : ""}</span>Compare</button>
                <div className="evidence-rank"><span>Rank</span><strong>#{finding.rank}</strong><small>{finding.evidence.length} retained excerpt{finding.evidence.length === 1 ? "" : "s"}</small></div>
                <div className="evidence-main">
                  <div className="evidence-title-row"><div><StatusBadge tone={finding.selected ? "success" : "info"}>{finding.selected ? "ProductSpec basis" : "Candidate"}</StatusBadge><h3>{finding.title}</h3></div>{evidence?.permalink ? <a aria-label={`Open retained source for ${finding.title}`} href={evidence.permalink} rel="noreferrer" target="_blank"><Icon name="external" size={18} /></a> : <span className="source-link-unavailable" aria-label="No source link retained"><Icon name="lock" size={17} /></span>}</div>
                  <p>{finding.summary}</p>
                  {finding.solution ? <div className="evidence-solution"><Icon name="spark" size={18} /><div><small>Solution direction</small><p>{finding.solution}</p></div></div> : null}
                  {evidence ? <><blockquote><Icon name="chat" size={17} /><span>“{evidence.quote}”</span></blockquote><div className="evidence-attribution"><span><Icon name="database" size={15} />{evidence.source}</span><code>{evidence.sourceId}</code><span>{evidence.attribution}</span></div></> : <div className="inline-notice"><Icon name="database" size={17} /><span>No minimal excerpt is retained for this finding.</span></div>}
                  <div className="finding-decision">
                    <Button
                      disabled={Boolean(project.spec) || choosing !== null || finding.selected || finding.evidence.length === 0}
                      icon={finding.selected ? "check" : "approval"}
                      kind="secondary"
                      onClick={() => chooseFinding(finding)}
                    >
                      {choosing === finding.id ? "Selecting…" : finding.selected ? "Selected basis" : "Use for ProductSpec"}
                    </Button>
                    {project.spec && <small>Basis locked by ProductSpec v{project.spec.version}</small>}
                  </div>
                </div>
                <div className="evidence-scores">
                  {Object.entries(finding.scores).map(([label, score]) => <div key={label}><span><small>{label}</small><strong>{score}/10</strong></span><i><b style={{ width: `${score * 10}%` }} /></i></div>)}
                </div>
              </article>
            );
          })}
        </div> : <EmptyState icon="search" title="No findings match" description="Adjust the search or sort to return to the ranked evidence set." action={<Button icon="close" onClick={() => { setQuery(""); setSort("rank"); }}>Clear filters</Button>} />}
      </> : <EmptyState icon="database" title="No findings yet" description={project.sourceMode === "import" ? "Upload an authorized research packet, then start research from Overview." : project.sourceMode === "live" && !project.liveAuthorized ? "Live Reddit research is locked. Use an authorized import or fixture until written approval is recorded." : "Start a fixture research run from Overview. Ranked findings and attributed excerpts will appear here."} />}

      {selected.length === 2 && (
        <Surface className="compare-drawer" aria-live="polite">
          <div><span className="eyebrow">Side-by-side check</span><h2>Compare problem signals</h2></div>
          {selected.map((id) => {
            const finding = project.findings.find((item) => item.id === id);
            if (!finding) return null;
            const average = Math.round(Object.values(finding.scores).reduce((sum, score) => sum + score, 0) / Object.values(finding.scores).length * 10) / 10;
            return <div className="compare-item" key={id}><span>#{finding.rank}</span><strong>{finding.title}</strong><small>Composite signal {average}/10</small></div>;
          })}
          <Button icon="close" onClick={() => setSelected([])}>Clear</Button>
        </Surface>
      )}
    </div>
  );
}
