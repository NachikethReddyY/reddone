"use client";

import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";

import { UsageReportSchema, type UsageReport } from "@/contracts";
import { buildUsageSearchParams, type UsageFilterState } from "./usage-format";

const UsageEnvelopeSchema = z.object({
  data: UsageReportSchema.optional(),
  error: z.object({ message: z.string().optional() }).passthrough().optional(),
}).passthrough();

export const usageQueryKeys = {
  report: (query: string) => ["usage", "report", query] as const,
};

export async function fetchUsageReport(filters: UsageFilterState): Promise<UsageReport> {
  const query = buildUsageSearchParams(filters).toString();
  const response = await fetch(`/api/v1/usage?${query}`, {
    cache: "no-store",
    credentials: "same-origin",
    headers: { accept: "application/json" },
  });
  const fallbackMessage = `Usage request failed (${response.status}).`;
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error(fallbackMessage);
  }
  const envelope = UsageEnvelopeSchema.safeParse(payload);
  if (!envelope.success) {
    throw new Error(response.ok ? "Usage response was invalid." : fallbackMessage);
  }
  if (!response.ok) {
    throw new Error(envelope.data.error?.message ?? fallbackMessage);
  }
  if (envelope.data.data === undefined) {
    throw new Error("Usage response was invalid.");
  }
  return envelope.data.data;
}

export function useUsageReportQuery(filters: UsageFilterState) {
  const queryClient = useQueryClient();
  const query = buildUsageSearchParams(filters).toString();
  return useQuery({
    queryKey: usageQueryKeys.report(query),
    queryFn: () => fetchUsageReport(filters),
    initialData: () => {
      const cachedReports = queryClient.getQueriesData<UsageReport>({ queryKey: ["usage", "report"] });
      for (let index = cachedReports.length - 1; index >= 0; index -= 1) {
        const [cachedKey, cachedReport] = cachedReports[index] ?? [];
        if (cachedReport && cachedKey?.[2] !== query) return cachedReport;
      }
      return undefined;
    },
    placeholderData: keepPreviousData,
  });
}
