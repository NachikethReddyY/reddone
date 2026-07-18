"use client";

import { ProjectHeader } from "@/components/project-header";
import { ProjectTabs } from "@/components/project-tabs";
import type { DemoProject, ProjectStatus } from "@/demo-data/control-plane";
import { useProjectQuery } from "@/features/projects/project-queries";
import { projectLifecycleFor, type ProjectViewModel } from "./project-view-data";

function headerStatus(project: ProjectViewModel): ProjectStatus {
  if (project.status === "paused") return "paused";
  if (project.status === "released" || project.status === "live") return "live";
  const lifecycle = projectLifecycleFor(project);
  if (lifecycle.current.id === "approve-spec") return "spec-review";
  if (lifecycle.current.id === "build") return "building";
  if (lifecycle.current.id === "release") return "release-ready";
  return "researching";
}

function headerProject(project: ProjectViewModel): DemoProject {
  const lifecycle = projectLifecycleFor(project);
  return {
    id: project.id,
    name: project.name,
    oneLiner: project.marketLabel,
    status: headerStatus(project),
    stageLabel: lifecycle.current.label,
    progress: Math.round(((lifecycle.stages.findIndex((stage) => stage.state === "current") + 1) / lifecycle.stages.length) * 100),
    blocker: lifecycle.blocker,
    nextAction: lifecycle.primaryAction.label,
    sourceMode: project.sourceMode,
    communities: [project.sourceLabel],
    findingCount: project.findings.length,
    evidenceDelta: 0,
    sandbox: lifecycle.current.id === "build" ? "Bounded builder + verifier" : "Not created",
    repository: project.repository?.fullName ?? "Not created",
    deployment: project.deployment?.url ?? "Not deployed",
    nextResearch: project.schedulesEnabled ? "Scheduled" : "Off",
    nextPolish: project.schedulesEnabled > 1 ? "Scheduled" : "Off",
    updatedAt: project.updatedAt ?? "Not recorded",
  };
}

export function ProjectChrome({ projectId }: { projectId: string }) {
  const projectQuery = useProjectQuery(projectId);
  const error = projectQuery.error instanceof Error ? projectQuery.error.message : "Project header is unavailable.";
  return (
    <div className="project-chrome">
      {projectQuery.data
        ? <ProjectHeader project={headerProject(projectQuery.data)} />
        : <div className={projectQuery.isError ? "inline-error" : "inline-notice"} role={projectQuery.isError ? "alert" : "status"}>{projectQuery.isError ? error : "Loading canonical project state…"}</div>}
      <ProjectTabs projectId={projectId} />
    </div>
  );
}
