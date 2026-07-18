import type { ReactNode } from "react";
import { ProjectChrome } from "@/features/project-detail/project-chrome";

export default async function ProjectLayout({ children, params }: { children: ReactNode; params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  return <div className="project-page"><ProjectChrome projectId={projectId} /><div className="project-content">{children}</div></div>;
}
