"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";

import { requestApiData } from "@/features/projects/project-queries";

import { conversationQueryKeys } from "./conversation-queries";

const ActionResultSchema = z.object({ id: z.string(), status: z.string() }).passthrough();

export function useConversationActionMutation(input: { projectId: string; conversationId: string | null; projectVersion: number | null; operation: "execute" | "dismiss" }) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (actionId: string) => requestApiData(
      `/api/v1/projects/${input.projectId}/conversation/${input.conversationId}/actions/${actionId}/${input.operation}`,
      ActionResultSchema,
      {
        method: "POST",
        headers: { "idempotency-key": `conversation-action-${input.operation}-${crypto.randomUUID()}`, "if-match": String(input.projectVersion ?? 0) },
      },
    ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: conversationQueryKeys.detail(input.projectId, input.conversationId ?? "none") });
      void queryClient.invalidateQueries({ queryKey: ["projects", "detail", input.projectId] });
    },
  });
}
