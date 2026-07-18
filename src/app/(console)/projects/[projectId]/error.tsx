"use client";

import { Button, ButtonLink, PageState } from "@/components/ui";

export default function ProjectError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <PageState
      action={<><Button kind="primary" icon="retry" onClick={reset}>Retry project</Button><ButtonLink href="/projects" icon="arrow-left">All projects</ButtonLink></>}
      description="The project state could not be loaded. No workflow action was taken."
      kind="error"
      title="This project is temporarily unavailable."
    />
  );
}
