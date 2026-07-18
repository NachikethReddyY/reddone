"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z, type ZodType } from "zod";

import {
  IdSchema,
  ProjectWorkspaceContextSchema,
  RunDetailSchema,
  RunEstimateResponseSchema,
  RunEventPageSchema,
  RunStatusSchema,
  type ProjectCreateInput,
  type ProjectDraftRunEstimateInput,
  type RunDetail,
  type RunEstimateResponse,
  type RunKind,
} from "@/contracts";
import { normalizeProjectView, type ProjectViewModel } from "@/features/project-detail/project-view-data";

const ApiEnvelopeSchema = z.object({
  data: z.unknown().optional(),
  error: z.object({ message: z.string().optional() }).passthrough().optional(),
}).passthrough();

const RunReferenceSchema = z.object({
  id: IdSchema,
  status: RunStatusSchema,
}).passthrough();

const ProjectCreateResultSchema = z.object({
  id: IdSchema,
  optimisticVersion: z.number().int().nonnegative().optional(),
  version: z.number().int().nonnegative().optional(),
}).passthrough();

const ProjectWorkspacePayloadSchema = ProjectWorkspaceContextSchema.extend({
  items: z.array(z.unknown()),
}).passthrough();

const BackendProviderStatusSchema = z.object({
  providers: z.object({
    kimi: z.boolean(),
    daytona: z.boolean(),
    reddit: z.boolean(),
    redditWebScraper: z.boolean().optional().default(false),
  }).strict(),
  discoveryReady: z.boolean(),
  buildReady: z.boolean(),
}).strict();

export const projectQueryKeys = {
  workspace: ["projects", "workspace-context"] as const,
  project: (projectId: string) => ["projects", "detail", projectId] as const,
  run: (runId: string) => ["runs", "detail", runId] as const,
  events: (runId: string) => ["runs", "events", runId] as const,
  estimate: (projectId: string, kind: string) => ["runs", "estimate", projectId, kind] as const,
  draftEstimate: (input: ProjectDraftRunEstimateInput) => ["runs", "estimate", "draft", input] as const,
  backendProviders: ["projects", "backend-providers"] as const,
};

export async function requestApiData<T>(url: string, schema: ZodType<T>, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    credentials: "same-origin",
    ...init,
    headers: {
      accept: "application/json",
      ...init?.headers,
    },
  });
  const envelope = ApiEnvelopeSchema.parse(await response.json().catch(() => null));
  if (!response.ok || envelope.data === undefined) {
    throw new Error(envelope.error?.message ?? `Request failed (${response.status}).`);
  }
  return schema.parse(envelope.data);
}

export async function createProjectRequest(input: ProjectCreateInput) {
  return requestApiData("/api/v1/projects", ProjectCreateResultSchema, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": `create-project-${crypto.randomUUID()}`,
    },
    body: JSON.stringify(input),
  });
}

export function useProjectWorkspaceContextQuery(enabled = true) {
  return useQuery({
    queryKey: projectQueryKeys.workspace,
    queryFn: () => requestApiData("/api/v1/projects", ProjectWorkspacePayloadSchema),
    enabled,
  });
}

export function useBackendProviderStatusQuery(enabled = true) {
  return useQuery({
    queryKey: projectQueryKeys.backendProviders,
    queryFn: () => requestApiData("/api/v1/providers/status", BackendProviderStatusSchema),
    enabled,
    staleTime: 60_000,
  });
}

export async function startProjectResearchRequest(input: {
  projectId: string;
  projectVersion: number;
  budgetCeilingMicros: number;
}) {
  return requestApiData(`/api/v1/projects/${input.projectId}/runs`, RunReferenceSchema, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": `research-${crypto.randomUUID()}`,
      "if-match": String(input.projectVersion),
    },
    body: JSON.stringify({ kind: "research", budgetCeilingMicros: input.budgetCeilingMicros }),
  });
}

export function useProjectQuery(projectId: string) {
  return useQuery({
    queryKey: projectQueryKeys.project(projectId),
    queryFn: async (): Promise<ProjectViewModel> => {
      const response = await fetch(`/api/v1/projects/${projectId}`, {
        credentials: "same-origin",
        headers: { accept: "application/json" },
      });
      const envelope = ApiEnvelopeSchema.parse(await response.json().catch(() => null));
      if (!response.ok || envelope.data === undefined) {
        throw new Error(envelope.error?.message ?? `Project request failed (${response.status}).`);
      }
      return normalizeProjectView(envelope.data, projectId);
    },
  });
}

export function useRunQuery(runId: string | null) {
  return useQuery({
    queryKey: projectQueryKeys.run(runId ?? "none"),
    queryFn: () => requestApiData(`/api/v1/runs/${runId}`, RunDetailSchema),
    enabled: Boolean(runId),
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status && ["queued", "running", "cancel_requested"].includes(status) ? 2_000 : false;
    },
  });
}

export function useRunEventsQuery(runId: string | null, active = false) {
  return useQuery({
    queryKey: projectQueryKeys.events(runId ?? "none"),
    queryFn: () => requestApiData(`/api/v1/runs/${runId}/events?limit=100`, RunEventPageSchema),
    enabled: Boolean(runId),
    refetchInterval: active ? 3_000 : false,
  });
}

export function useRunEstimateQuery(projectId: string, kind: "research" | "build" | "polish", enabled = true) {
  return useQuery({
    queryKey: projectQueryKeys.estimate(projectId, kind),
    queryFn: () => requestApiData(`/api/v1/projects/${projectId}/run-estimate`, RunEstimateResponseSchema, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind }),
    }),
    enabled,
    staleTime: 60_000,
  });
}

export function useDraftRunEstimateQuery(input: ProjectDraftRunEstimateInput | null) {
  return useQuery({
    queryKey: input ? projectQueryKeys.draftEstimate(input) : ["runs", "estimate", "draft", "disabled"],
    queryFn: () => requestApiData("/api/v1/projects/run-estimate", RunEstimateResponseSchema, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }),
    enabled: Boolean(input),
    staleTime: 30_000,
  });
}

type StartRunInput = {
  kind: Extract<RunKind, "research" | "build" | "polish">;
  projectVersion: number;
  budgetCeilingMicros: number;
  specVersionId?: string;
};

export function useStartRunMutation(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: StartRunInput) => requestApiData(`/api/v1/projects/${projectId}/runs`, RunReferenceSchema, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": `${input.kind}-${crypto.randomUUID()}`,
        "if-match": String(input.projectVersion),
      },
      body: JSON.stringify({
        kind: input.kind,
        budgetCeilingMicros: input.budgetCeilingMicros,
        ...(input.specVersionId ? { specVersionId: input.specVersionId } : {}),
      }),
    }),
    onSuccess: async (run) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: projectQueryKeys.project(projectId) }),
        queryClient.invalidateQueries({ queryKey: projectQueryKeys.run(run.id) }),
        queryClient.invalidateQueries({ queryKey: ["shell", "projects"] }),
      ]);
    },
  });
}

function useRunActionMutation(action: "cancel" | "retry") {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ runId, stateVersion }: { runId: string; stateVersion: number }) => requestApiData(
      `/api/v1/runs/${runId}/${action}`,
      RunReferenceSchema,
      {
        method: "POST",
        headers: {
          "idempotency-key": `${action}-${crypto.randomUUID()}`,
          "if-match": String(stateVersion),
        },
      },
    ),
    onSuccess: async (run) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: projectQueryKeys.run(run.id) }),
        queryClient.invalidateQueries({ queryKey: projectQueryKeys.events(run.id) }),
        queryClient.invalidateQueries({ queryKey: ["projects", "detail"] }),
      ]);
    },
  });
}

export function useCancelRunMutation() {
  return useRunActionMutation("cancel");
}

export function useRetryRunMutation() {
  return useRunActionMutation("retry");
}

export type ProjectRunDetail = RunDetail;
export type ProjectRunEstimate = RunEstimateResponse;
