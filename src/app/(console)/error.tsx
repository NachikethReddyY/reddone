"use client";

import { Button, ButtonLink, PageState } from "@/components/ui";

export default function ConsoleError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="page-shell">
      <PageState
        action={<><Button kind="primary" icon="retry" onClick={reset}>Try again</Button><ButtonLink href="/projects" icon="projects">Open projects</ButtonLink></>}
        description="The workspace view could not be loaded. Retry the request or return to the project list."
        kind="error"
        title="The control plane hit a recoverable error."
      />
    </div>
  );
}
