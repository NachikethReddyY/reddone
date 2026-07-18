import { PageHeader } from "@/components/page-header";
import { ProjectWizard } from "@/features/projects/project-wizard";
import { isDemoMode } from "@/server/env";

export const metadata = { title: "New project" };

export default function NewProjectPage() {
  return (
    <div className="page-shell narrow-page">
      <PageHeader breadcrumb={[{ label: "Projects", href: "/projects" }, { label: "New project" }]} eyebrow="Evidence-first setup" title="Create a project" description="Define the market, choose an approved source, and lock the guardrails before any analysis begins." />
      <ProjectWizard demoMode={isDemoMode()} />
    </div>
  );
}

