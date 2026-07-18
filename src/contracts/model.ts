import { z } from "zod";

/** Models explicitly approved for ReDDone's structured and tool-calling workflows. */
export const WorkflowModelSchema = z.enum([
  "zai-org/glm-5.2",
  "moonshotai/kimi-k2.7-code",
]);

export const WorkflowModelOptions = [
  { id: "zai-org/glm-5.2", label: "GLM-5.2", description: "1M context · reasoning and tool calling" },
  { id: "moonshotai/kimi-k2.7-code", label: "Kimi K2.7 Code", description: "Code-focused · reasoning and tool calling" },
] as const;

export const DEFAULT_RESEARCH_MODEL = "zai-org/glm-5.2" as const;
export const DEFAULT_BUILDER_MODEL = "moonshotai/kimi-k2.7-code" as const;

/** Backward-compatible fallback for historical run payloads that do not expose a run kind. */
export const DEFAULT_WORKFLOW_MODEL = DEFAULT_BUILDER_MODEL;

export type WorkflowModel = z.infer<typeof WorkflowModelSchema>;
