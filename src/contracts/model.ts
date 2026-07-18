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

export const DEFAULT_WORKFLOW_MODEL = "moonshotai/kimi-k2.7-code" as const;

export type WorkflowModel = z.infer<typeof WorkflowModelSchema>;
