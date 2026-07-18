import type { UsageReport } from "@/contracts";
import type { UsageMetric } from "./usage-format";

export const USAGE_CHART_SIZE = {
  width: 760,
  height: 340,
  top: 24,
  right: 126,
  bottom: 52,
  left: 68,
} as const;

export type UsageChartPoint = {
  x: number;
  y: number;
  value: string;
  bucketIndex: number;
};

export type UsageChartSeries = {
  key: "cost" | "input" | "output";
  label: string;
  points: UsageChartPoint[];
  path: string;
  dashed: boolean;
  marker: "circle" | "diamond";
};

export type UsageChartGeometry = {
  width: number;
  height: number;
  plotLeft: number;
  plotRight: number;
  plotTop: number;
  plotBottom: number;
  plotWidth: number;
  plotHeight: number;
  yMax: number;
  yTicks: Array<{ value: number; y: number }>;
  xTicks: Array<{ bucketIndex: number; x: number }>;
  hitZones: Array<{ x: number; width: number; center: number }>;
  series: UsageChartSeries[];
  directLabels: Array<{ key: UsageChartSeries["key"]; label: string; x: number; y: number; sourceY: number }>;
};

function numeric(value: string) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return parsed;
}

function niceMaximum(value: number) {
  if (value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const normalized = value / magnitude;
  const step = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return step * magnitude;
}

function linePath(points: UsageChartPoint[]) {
  return points.map((point, index) => `${index === 0 ? "M" : "L"}${point.x.toFixed(2)},${point.y.toFixed(2)}`).join(" ");
}

function tickIndices(length: number) {
  if (length <= 1) return [0];
  const candidates = [0, Math.round((length - 1) * .25), Math.round((length - 1) * .5), Math.round((length - 1) * .75), length - 1];
  return [...new Set(candidates)];
}

function adjustedLabelYs(series: UsageChartSeries[], plotTop: number, plotBottom: number) {
  const labels = series.map((item) => {
    const point = item.points.at(-1);
    return { item, sourceY: point?.y ?? plotBottom, y: point?.y ?? plotBottom };
  });
  if (labels.length === 2 && Math.abs(labels[0]!.y - labels[1]!.y) < 22) {
    const firstAbove = labels[0]!.y <= labels[1]!.y;
    labels[0]!.y += firstAbove ? -12 : 12;
    labels[1]!.y += firstAbove ? 12 : -12;
  }
  return labels.map(({ item, sourceY, y }) => ({
    key: item.key,
    label: item.label,
    x: (item.points.at(-1)?.x ?? 0) + 14,
    sourceY,
    y: Math.max(plotTop + 8, Math.min(plotBottom - 8, y)),
  }));
}

export function createUsageChartGeometry(buckets: UsageReport["buckets"], metric: UsageMetric): UsageChartGeometry {
  const { width, height, top: plotTop, right, bottom, left: plotLeft } = USAGE_CHART_SIZE;
  const plotRight = width - right;
  const plotBottom = height - bottom;
  const plotWidth = plotRight - plotLeft;
  const plotHeight = plotBottom - plotTop;
  const definitions = metric === "cost"
    ? [{ key: "cost" as const, label: "Provider cost", value: (bucket: UsageReport["buckets"][number]) => bucket.costMicros, dashed: false, marker: "circle" as const }]
    : [
        { key: "input" as const, label: "Input tokens", value: (bucket: UsageReport["buckets"][number]) => bucket.inputTokens, dashed: false, marker: "circle" as const },
        { key: "output" as const, label: "Output tokens", value: (bucket: UsageReport["buckets"][number]) => bucket.outputTokens, dashed: true, marker: "diamond" as const },
      ];
  const rawMaximum = Math.max(0, ...definitions.flatMap((definition) => buckets.map((bucket) => numeric(definition.value(bucket)))));
  const yMax = niceMaximum(rawMaximum);
  const xFor = (index: number) => buckets.length <= 1 ? plotLeft + plotWidth / 2 : plotLeft + (index / (buckets.length - 1)) * plotWidth;
  const yFor = (value: number) => plotBottom - (value / yMax) * plotHeight;
  const series = definitions.map((definition) => {
    const points = buckets.map((bucket, bucketIndex) => ({
      x: xFor(bucketIndex),
      y: yFor(numeric(definition.value(bucket))),
      value: definition.value(bucket),
      bucketIndex,
    }));
    return { ...definition, points, path: linePath(points) };
  });
  const slotWidth = buckets.length <= 1 ? plotWidth : plotWidth / (buckets.length - 1);
  const hitZones = buckets.map((_, index) => {
    const center = xFor(index);
    const start = index === 0 ? plotLeft : center - slotWidth / 2;
    const end = index === buckets.length - 1 ? plotRight : center + slotWidth / 2;
    return { x: start, width: Math.max(1, end - start), center };
  });
  const yTicks = Array.from({ length: 5 }, (_, index) => {
    const value = yMax * (index / 4);
    return { value, y: yFor(value) };
  });
  return {
    width,
    height,
    plotLeft,
    plotRight,
    plotTop,
    plotBottom,
    plotWidth,
    plotHeight,
    yMax,
    yTicks,
    xTicks: tickIndices(buckets.length).map((bucketIndex) => ({ bucketIndex, x: xFor(bucketIndex) })),
    hitZones,
    series,
    directLabels: adjustedLabelYs(series, plotTop, plotBottom),
  };
}
