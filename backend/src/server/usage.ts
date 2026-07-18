import "server-only";

import type { Prisma } from "@prisma/client";
import type { KimiUsageSample } from "@/integrations/kimi";

import { getDb } from "./db";

export const KIMI_PRICING_VERSION = "2026-07-17.v1";
const MICROS_PER_MILLION = 1_000_000n;

type KimiRateName = "KIMI_INPUT_COST_MICROS_PER_MILLION" | "KIMI_OUTPUT_COST_MICROS_PER_MILLION";

export interface KimiPricingSnapshot {
  inputRateMicrosPerMillion: bigint | null;
  outputRateMicrosPerMillion: bigint | null;
  pricingVersion: string | null;
}

function configuredRate(environment: Readonly<Record<string, string | undefined>>, name: KimiRateName) {
  const value = environment[name]?.trim();
  if (!value || !/^\d{1,15}$/.test(value)) return null;
  return BigInt(value);
}

export function getKimiPricingSnapshot(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): KimiPricingSnapshot {
  const inputRateMicrosPerMillion = configuredRate(environment, "KIMI_INPUT_COST_MICROS_PER_MILLION");
  const outputRateMicrosPerMillion = configuredRate(environment, "KIMI_OUTPUT_COST_MICROS_PER_MILLION");
  return {
    inputRateMicrosPerMillion,
    outputRateMicrosPerMillion,
    pricingVersion:
      inputRateMicrosPerMillion !== null && outputRateMicrosPerMillion !== null
        ? KIMI_PRICING_VERSION
        : null,
  };
}

function tokenUnits(value: number) {
  return BigInt(Math.max(0, Math.trunc(value)));
}

export function estimateProviderCostMicros(input: {
  inputTokens: bigint;
  outputTokens: bigint;
  inputRateMicrosPerMillion: bigint;
  outputRateMicrosPerMillion: bigint;
}) {
  const numerator =
    input.inputTokens * input.inputRateMicrosPerMillion
    + input.outputTokens * input.outputRateMicrosPerMillion;
  return (numerator + MICROS_PER_MILLION - 1n) / MICROS_PER_MILLION;
}

export function kimiUsageCostMicros(
  sample: Pick<KimiUsageSample, "inputUnits" | "outputUnits">,
  snapshot = getKimiPricingSnapshot(),
) {
  return estimateProviderCostMicros({
    inputTokens: tokenUnits(sample.inputUnits),
    outputTokens: tokenUnits(sample.outputUnits),
    inputRateMicrosPerMillion: snapshot.inputRateMicrosPerMillion ?? 0n,
    outputRateMicrosPerMillion: snapshot.outputRateMicrosPerMillion ?? 0n,
  });
}

/** Records provider usage exactly once and advances the canonical run/reservation totals. */
export async function recordKimiUsage(input: {
  workspaceId: string;
  projectId: string;
  runId: string;
  sample: KimiUsageSample;
}) {
  const pricing = getKimiPricingSnapshot();
  const costMicros = kimiUsageCostMicros(input.sample, pricing);
  const inputUnits = tokenUnits(input.sample.inputUnits);
  const outputUnits = tokenUnits(input.sample.outputUnits);
  const occurredAt = new Date();
  return getDb().$transaction(async (tx) => {
    const existing = await tx.usageLedger.findUnique({
      where: {
        workspaceId_provider_externalUsageId: {
          workspaceId: input.workspaceId,
          provider: "KIMI",
          externalUsageId: input.sample.externalUsageId,
        },
      },
    });
    if (existing) {
      if (existing.runId !== input.runId || existing.projectId !== input.projectId) {
        throw new Error("Provider usage identifier collision was rejected.");
      }
      const reservation = await tx.budgetReservation.findFirst({
        where: { workspaceId: input.workspaceId, projectId: input.projectId, runId: input.runId, provider: "KIMI" },
      });
      return {
        created: false,
        costMicros: existing.costMicros,
        totalActualMicros: reservation?.actualMicros ?? existing.costMicros,
        exceeded: !reservation || (reservation.actualMicros ?? 0n) > reservation.reservedMicros,
      };
    }

    await tx.usageLedger.create({
      data: {
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        runId: input.runId,
        provider: "KIMI",
        externalUsageId: input.sample.externalUsageId,
        model: input.sample.model,
        operation: input.sample.operation,
        inputUnits,
        outputUnits,
        inputRateMicrosPerMillion: pricing.inputRateMicrosPerMillion,
        outputRateMicrosPerMillion: pricing.outputRateMicrosPerMillion,
        pricingVersion: pricing.pricingVersion,
        costMicros,
        metadata: {
          model: input.sample.model,
          unit: "token",
          pricingConfigured: pricing.pricingVersion !== null,
        } satisfies Prisma.InputJsonValue,
        occurredAt,
      },
    });
    await tx.workflowRun.updateMany({
      where: { id: input.runId, workspaceId: input.workspaceId, projectId: input.projectId },
      data: { actualCostMicros: { increment: costMicros } },
    });
    const reservation = await tx.budgetReservation.findFirst({
      where: { workspaceId: input.workspaceId, projectId: input.projectId, runId: input.runId, provider: "KIMI" },
    });
    const actualMicros = (reservation?.actualMicros ?? 0n) + costMicros;
    if (reservation) {
      await tx.budgetReservation.update({
        where: { id: reservation.id },
        data: {
          actualMicros,
          ...(actualMicros > reservation.reservedMicros && reservation.status !== "RELEASED"
            ? { status: "EXCEEDED" as const }
            : {}),
        },
      });
    }
    return {
      created: true,
      costMicros,
      totalActualMicros: actualMicros,
      exceeded: !reservation || actualMicros > reservation.reservedMicros,
    };
  }, { isolationLevel: "Serializable", timeout: 10_000 });
}
