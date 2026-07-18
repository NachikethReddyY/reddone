import { PageHeader } from "@/components/page-header";
import { CreateProjectButton } from "@/features/projects/create-project-dialog";
import { ProjectsDashboard } from "@/features/projects/projects-dashboard";

export const metadata = { title: "Projects" };

export default function ProjectsPage() {
  return (
    <div className="page-shell">
      <PageHeader eyebrow="Workspace / Projects" title="Projects" description="Every product’s blocker, evidence, verification state, and next safe action." actions={<CreateProjectButton kind="primary">New project</CreateProjectButton>} />
      <ProjectsDashboard />
    </div>
  );
}
