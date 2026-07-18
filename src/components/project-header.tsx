import Link from "next/link";
import { Icon } from "@/components/icons";
import { ButtonLink, SourceBadge, StatusBadge } from "@/components/ui";
import type { DemoProject } from "@/demo-data/control-plane";

const projectTone = {
  researching: "info",
  "spec-review": "warning",
  building: "info",
  "release-ready": "warning",
  live: "success",
  paused: "neutral",
} as const;

export function ProjectHeader({ project }: { project: DemoProject }) {
  const nextControl = project.status === "spec-review" || project.status === "release-ready"
    ? { href: "/approvals", label: "Review approval", icon: "approval" as const, primary: true }
    : project.status === "building"
      ? { href: `/projects/${project.id}/builds`, label: "Inspect build", icon: "terminal" as const, primary: false }
      : project.status === "live"
        ? { href: `/projects/${project.id}/releases`, label: "View release", icon: "globe" as const, primary: false }
        : { href: `/projects/${project.id}/evidence`, label: "View evidence", icon: "database" as const, primary: false };
  return (
    <header className="project-header">
      <nav aria-label="Breadcrumb" className="breadcrumb">
        <span><Link href="/projects">Projects</Link></span>
        <span><Icon name="chevron-right" size={14} /><span aria-current="page">{project.name}</span></span>
      </nav>
      <div className="project-title-row">
        <div className="project-identity">
          <span className="project-monogram" aria-hidden="true">{project.name.split(" ").map((part) => part[0]).join("").slice(0, 2)}</span>
          <div>
            <div className="project-title-meta"><StatusBadge tone={projectTone[project.status]} pulse={project.status === "researching"}>{project.stageLabel}</StatusBadge><SourceBadge mode={project.sourceMode} /></div>
            <h1>{project.name}</h1>
            <p>{project.oneLiner}</p>
          </div>
        </div>
        <div className="page-actions project-actions">
          <ButtonLink href={nextControl.href} kind={nextControl.primary ? "primary" : "secondary"} icon={nextControl.icon}>{nextControl.label}</ButtonLink>
        </div>
      </div>
    </header>
  );
}
