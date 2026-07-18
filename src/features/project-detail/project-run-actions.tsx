"use client";

import { Button } from "@/components/ui";
import { useStartRunMutation } from "@/features/projects/project-queries";

export function ProjectRunActions({
  projectId,
  optimisticVersion,
  maxCostMicrosPerRun,
  onQueued,
}: {
  projectId: string;
  optimisticVersion: number;
  maxCostMicrosPerRun: number;
  onQueued?: () => void;
}) {
  const startRun = useStartRunMutation(projectId);

  async function startResearch() {
    await startRun.mutateAsync({
      kind: "research",
      projectVersion: optimisticVersion,
      budgetCeilingMicros: Math.min(2_500_000, maxCostMicrosPerRun),
    });
    onQueued?.();
  }

  return (
    <div className="primary-run-action">
      <Button kind="primary" disabled={startRun.isPending || maxCostMicrosPerRun < 1} icon="activity" onClick={() => void startResearch()}>
        {startRun.isPending ? "Starting research…" : "Run research"}
      </Button>
      {startRun.isError && <small role="alert">{startRun.error instanceof Error ? startRun.error.message : "Research could not start."}</small>}
    </div>
  );
}
