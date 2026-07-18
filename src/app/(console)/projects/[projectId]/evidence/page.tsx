import { EvidenceView } from "@/features/project-detail/evidence-view";

export default async function ProjectEvidencePage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  return <EvidenceView projectId={projectId} />;
}
