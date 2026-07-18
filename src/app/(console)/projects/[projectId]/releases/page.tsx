import { ReleasesView } from "@/features/project-detail/releases-view";

export default async function ProjectReleasesPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  return <ReleasesView projectId={projectId} />;
}
