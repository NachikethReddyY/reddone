"use client";

import { useState } from "react";

import { DEFAULT_WORKFLOW_MODEL, WorkflowModelOptions, type WorkflowModel } from "@/contracts";
import { Button } from "@/components/ui";
import type { ProjectViewModel } from "./project-view-data";

async function responseMessage(response: Response) {
  const body = await response.json().catch(() => null) as {
    error?: { message?: string };
  } | null;
  if (!response.ok) throw new Error(body?.error?.message ?? `Specification request failed (${response.status}).`);
}

export function FindingSpecAction({
  project,
  onQueued,
}: {
  project: ProjectViewModel;
  onQueued: () => void;
}) {
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState("");
  const [failed, setFailed] = useState(false);
  const [model, setModel] = useState<WorkflowModel>(DEFAULT_WORKFLOW_MODEL);
  const selected = project.selectedFinding;
  if (!selected || project.spec) return null;
  const active = project.runs.some((run) => ["queued", "running", "cancel_requested"].includes(run.status));
  const ceiling = Math.min(2_500_000, project.maxCostMicrosPerRun);

  async function generate() {
    setWorking(true);
    setFailed(false);
    setMessage("Reserving the specification budget and queuing a durable run…");
    try {
      const response = await fetch(`/api/v1/projects/${project.id}/findings/${selected!.id}/spec`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": `finding-spec-${crypto.randomUUID()}`,
          "if-match": `"${project.optimisticVersion}"`,
        },
        body: JSON.stringify({ budgetCeilingMicros: ceiling, model }),
      });
      await responseMessage(response);
      setMessage("ProductSpec generation was queued. Provider work will run outside this request.");
      onQueued();
    } catch (error) {
      setFailed(true);
      setMessage(error instanceof Error ? error.message : "ProductSpec generation could not be queued.");
    } finally {
      setWorking(false);
    }
  }

  return (
    <div className="finding-spec-action">
      <label className="form-field compact-field">
        <span>Model for this ProductSpec</span>
        <select aria-label="Model for this ProductSpec" value={model} onChange={(event) => setModel(event.target.value as WorkflowModel)}>
          {WorkflowModelOptions.map((option) => <option key={option.id} value={option.id}>{option.label} — {option.description}</option>)}
        </select>
      </label>
      <Button
        disabled={working || active || ceiling < 1}
        icon="spark"
        kind="primary"
        onClick={generate}
      >
        {working ? "Queuing…" : active ? "Workflow active" : ceiling < 1 ? "Set a cost ceiling" : "Generate ProductSpec"}
      </Button>
      {message && <small aria-live="polite" className={failed ? "form-error" : "form-notice"} role={failed ? "alert" : "status"}>{message}</small>}
    </div>
  );
}
