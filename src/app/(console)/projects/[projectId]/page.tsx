import { ProjectConversationWorkspace } from "@/features/chat/project-conversation-workspace";

export default async function ProjectConversationPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  return <ProjectConversationWorkspace projectId={projectId} />;
}
