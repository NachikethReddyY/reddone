import { SpecEditor } from "@/features/project-detail/spec-editor";

export default async function ProjectSpecPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  return <SpecEditor projectId={projectId} />;
}
