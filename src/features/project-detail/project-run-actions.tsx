"use client";

import { useState } from "react";

import { DEFAULT_WORKFLOW_MODEL, WorkflowModelOptions, type WorkflowModel } from "@/contracts";
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
  const [model, setModel] = useState<WorkflowModel>(DEFAULT_WORKFLOW_MODEL);

  async function startResearch() {
    await startRun.mutateAsync({
      kind: "research",
      model,
      projectVersion: optimisticVersion,
      budgetCeilingMicros: Math.min(2_500_000, maxCostMicrosPerRun),
    });
    onQueued?.();
  }

  return (
    <div className="primary-run-action">
      <label className="form-field compact-field">
        <span>Model for this research run</span>
        <select aria-label="Model for this research run" value={model} onChange={(event) => setModel(event.target.value as WorkflowModel)}>
          {WorkflowModelOptions.map((option) => <option key={option.id} value={option.id}>{option.label} — {option.description}</option>)}
        </select>
      </label>
      <Button kind="primary" disabled={startRun.isPending || maxCostMicrosPerRun < 1} icon="activity" onClick={() => void startResearch()}>
        {startRun.isPending ? "Starting research…" : "Run research"}
      </Button>
      {startRun.isError && <small role="alert">{startRun.error instanceof Error ? startRun.error.message : "Research could not start."}</small>}
    </div>
  );
}
