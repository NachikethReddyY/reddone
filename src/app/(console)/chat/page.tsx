import { redirect } from "next/navigation";

export const metadata = { title: "Projects" };

export default async function ChatPage({ searchParams }: { searchParams?: Promise<{ projectId?: string | string[] }> } = {}) {
  const { projectId } = searchParams ? await searchParams : {};
  if (typeof projectId === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(projectId)) {
    redirect(`/projects/${encodeURIComponent(projectId)}`);
  }
  redirect("/projects");
}
