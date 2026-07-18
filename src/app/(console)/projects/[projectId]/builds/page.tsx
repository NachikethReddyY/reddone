import { BuildsView } from "@/features/project-detail/builds-view";

export default async function ProjectBuildsPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  return <BuildsView projectId={projectId} />;
}
