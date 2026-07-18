import { ButtonLink, PageState } from "@/components/ui";

export default function NotFound() {
  return (
    <main className="page-shell">
      <PageState
        action={<ButtonLink href="/projects" kind="primary" icon="arrow-left">Return to projects</ButtonLink>}
        description="The destination may have moved, or it is not available in this workspace."
        kind="not-found"
        title="This route is not in the control plane."
      />
    </main>
  );
}
