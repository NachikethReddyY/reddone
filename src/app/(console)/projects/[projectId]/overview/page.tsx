import { OverviewView } from "@/features/project-detail/overview-view";

export default async function ProjectOverviewPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  return <OverviewView projectId={projectId} />;
}
