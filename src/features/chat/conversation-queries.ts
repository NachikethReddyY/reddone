"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";

import {
  ConversationDetailSchema,
  ConversationThreadSchema,
  CreateConversationInputSchema,
  CreateTurnInputSchema,
} from "@/contracts";
import { requestApiData } from "@/features/projects/project-queries";

const ConversationListSchema = z.object({ items: z.array(ConversationThreadSchema) }).strict();
const TurnStartSchema = z.object({ id: z.string(), status: z.string(), streamUrl: z.string().url(), replayed: z.boolean(), dispatchStatus: z.string() }).strict();

export const conversationQueryKeys = {
  list: (projectId: string) => ["conversation", projectId, "list"] as const,
  detail: (projectId: string, conversationId: string) => ["conversation", projectId, "detail", conversationId] as const,
  activity: (projectId: string) => ["conversation", projectId, "activity"] as const,
};

export function useConversationListQuery(projectId: string) {
  return useQuery({
    queryKey: conversationQueryKeys.list(projectId),
    queryFn: () => requestApiData(`/api/v1/projects/${projectId}/conversation`, ConversationListSchema),
  });
}

export function useConversationDetailQuery(projectId: string, conversationId: string | null) {
  return useQuery({
    queryKey: conversationQueryKeys.detail(projectId, conversationId ?? "none"),
    queryFn: () => requestApiData(`/api/v1/projects/${projectId}/conversation/${conversationId}`, ConversationDetailSchema),
    enabled: Boolean(conversationId),
  });
}

export function useCreateConversationMutation(projectId: string, projectVersion: number | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { title: string }) => requestApiData(
      `/api/v1/projects/${projectId}/conversation`,
      ConversationThreadSchema,
      {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": `conversation-${crypto.randomUUID()}`, "if-match": String(projectVersion ?? 0) },
        body: JSON.stringify(CreateConversationInputSchema.parse(input)),
      },
    ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: conversationQueryKeys.list(projectId) }),
  });
}

export function useCreateTurnMutation(projectId: string, conversationId: string | null, projectVersion: number | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { message: string }) => requestApiData(
      `/api/v1/projects/${projectId}/conversation/${conversationId}/turns`,
      TurnStartSchema,
      {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": `conversation-turn-${crypto.randomUUID()}`, "if-match": String(projectVersion ?? 0) },
        body: JSON.stringify(CreateTurnInputSchema.parse(input)),
      },
    ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: conversationQueryKeys.detail(projectId, conversationId ?? "none") });
      void queryClient.invalidateQueries({ queryKey: conversationQueryKeys.list(projectId) });
    },
  });
}

export function useCancelTurnMutation(projectId: string, conversationId: string | null, projectVersion: number | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (turnId: string) => requestApiData(
      `/api/v1/projects/${projectId}/conversation/${conversationId}/turns/${turnId}/cancel`,
      z.object({ canceled: z.boolean(), cancellationRequested: z.boolean(), turnId: z.string() }).strict(),
      { method: "POST", headers: { "idempotency-key": `conversation-cancel-${crypto.randomUUID()}`, "if-match": String(projectVersion ?? 0) } },
    ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: conversationQueryKeys.detail(projectId, conversationId ?? "none") }),
  });
}
