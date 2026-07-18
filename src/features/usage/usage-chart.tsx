"use client";

import { useId, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";

import type { UsageReport } from "@/contracts";
import { createUsageChartGeometry, type UsageChartSeries } from "./usage-chart-geometry";
import {
  formatBucketDate,
  formatMicrodollars,
  formatMicrodollarsAccessible,
  formatTokens,
  type UsageMetric,
} from "./usage-format";

function formatAxisValue(value: number, metric: UsageMetric) {
  const rounded = BigInt(Math.max(0, Math.round(value)));
  return metric === "cost" ? formatMicrodollars(rounded) : formatTokens(rounded, true);
}

function seriesClass(key: UsageChartSeries["key"]) {
  return `usage-series usage-series-${key}`;
}

function Marker({ series, x, y, active = false }: { series: UsageChartSeries; x: number; y: number; active?: boolean }) {
  if (series.marker === "diamond") {
    const radius = active ? 6 : 4.5;
    return <rect aria-hidden="true" className={`${seriesClass(series.key)} usage-chart-marker`} height={radius * 2} rx="1" transform={`rotate(45 ${x} ${y})`} width={radius * 2} x={x - radius} y={y - radius} />;
  }
  return <circle aria-hidden="true" className={`${seriesClass(series.key)} usage-chart-marker`} cx={x} cy={y} r={active ? 6 : 4.5} />;
}

function bucketAriaLabel(bucket: UsageReport["buckets"][number], metric: UsageMetric, granularity: "day" | "week") {
  const date = formatBucketDate(bucket.start, granularity, true);
  if (metric === "cost") return `${date}, provider cost ${formatMicrodollarsAccessible(bucket.costMicros)}, ${bucket.providerCalls} Kimi calls`;
  return `${date}, ${formatTokens(bucket.inputTokens)} input tokens and ${formatTokens(bucket.outputTokens)} output tokens`;
}

export function UsageTimeSeries({ report, metric }: { report: UsageReport; metric: UsageMetric }) {
  const titleId = useId();
  const descriptionId = useId();
  const geometry = useMemo(() => createUsageChartGeometry(report.buckets, metric), [metric, report.buckets]);
  const [rovingIndex, setRovingIndex] = useState(0);
  const [focusedIndex, setFocusedIndex] = useState<number | null>(null);
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const hitZoneRefs = useRef<Array<SVGRectElement | null>>([]);
  const activeIndex = hoveredIndex ?? focusedIndex;
  const tabbableIndex = Math.min(rovingIndex, Math.max(0, report.buckets.length - 1));
  const activeBucket = activeIndex === null ? null : report.buckets[activeIndex] ?? null;
  const activeX = activeIndex === null ? null : geometry.hitZones[activeIndex]?.center ?? null;

  function moveFocus(event: KeyboardEvent<SVGRectElement>, index: number) {
    let target = index;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") target = Math.min(report.buckets.length - 1, index + 1);
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp") target = Math.max(0, index - 1);
    else if (event.key === "Home") target = 0;
    else if (event.key === "End") target = report.buckets.length - 1;
    else return;
    event.preventDefault();
    setRovingIndex(target);
    hitZoneRefs.current[target]?.focus();
  }

  const tooltipStyle = activeX === null ? undefined : ({ "--usage-tooltip-x": `${(activeX / geometry.width) * 100}%` } as CSSProperties);

  return (
    <div className="usage-chart-wrap" onMouseLeave={() => setHoveredIndex(null)}>
      {metric === "tokens" && (
        <div aria-label="Token series legend" className="usage-chart-legend" role="list">
          <span role="listitem"><i className="usage-legend-line usage-legend-input" aria-hidden="true" />Input tokens</span>
          <span role="listitem"><i className="usage-legend-line usage-legend-output" aria-hidden="true" />Output tokens</span>
        </div>
      )}
      <svg
        aria-describedby={descriptionId}
        aria-labelledby={titleId}
        className="usage-chart"
        role="group"
        viewBox={`0 0 ${geometry.width} ${geometry.height}`}
      >
        <title id={titleId}>{metric === "cost" ? "Provider cost over time" : "Input and output tokens over time"}</title>
        <desc id={descriptionId}>Use Tab to enter the chart, then arrow keys to move between time buckets. The complete values also appear in the table below.</desc>
        {geometry.yTicks.map((tick) => (
          <g aria-hidden="true" key={tick.value}>
            <line className={tick.value === 0 ? "usage-chart-baseline" : "usage-chart-gridline"} x1={geometry.plotLeft} x2={geometry.plotRight} y1={tick.y} y2={tick.y} />
            <text className="usage-chart-axis-label" textAnchor="end" x={geometry.plotLeft - 12} y={tick.y + 4}>{formatAxisValue(tick.value, metric)}</text>
          </g>
        ))}
        {geometry.xTicks.map((tick) => {
          const bucket = report.buckets[tick.bucketIndex];
          return bucket ? (
            <text aria-hidden="true" className="usage-chart-axis-label" key={tick.bucketIndex} textAnchor="middle" x={tick.x} y={geometry.plotBottom + 30}>
              {formatBucketDate(bucket.start, report.query.granularity)}
            </text>
          ) : null;
        })}
        {geometry.series.map((series) => {
          const markerPoints = series.points.length <= 14 ? series.points : series.points.slice(-1);
          return (
            <g aria-hidden="true" key={series.key}>
              <path className={`${seriesClass(series.key)} usage-chart-line ${series.dashed ? "is-dashed" : ""}`} d={series.path} data-testid={`usage-series-${series.key}`} />
              {markerPoints.map((point) => <Marker key={point.bucketIndex} series={series} x={point.x} y={point.y} />)}
            </g>
          );
        })}
        {activeX !== null && (
          <g aria-hidden="true">
            <line className="usage-chart-crosshair" x1={activeX} x2={activeX} y1={geometry.plotTop} y2={geometry.plotBottom} />
            {geometry.series.map((series) => {
              const point = activeIndex === null ? undefined : series.points[activeIndex];
              return point ? <Marker active key={series.key} series={series} x={point.x} y={point.y} /> : null;
            })}
          </g>
        )}
        {geometry.directLabels.map((label) => (
          <g aria-hidden="true" className={`usage-direct-label usage-direct-${label.key}`} key={label.key}>
            {Math.abs(label.sourceY - label.y) > 2 && <line x1={label.x - 14} x2={label.x - 3} y1={label.sourceY} y2={label.y} />}
            <text x={label.x} y={label.y + 4}>{label.label}</text>
          </g>
        ))}
        <g aria-label="Usage time buckets" role="list">
          {geometry.hitZones.map((zone, index) => {
            const bucket = report.buckets[index];
            return bucket ? (
              <rect
                aria-label={bucketAriaLabel(bucket, metric, report.query.granularity)}
                aria-posinset={index + 1}
                aria-setsize={report.buckets.length}
                className="usage-chart-hit-zone"
                data-bucket-index={index}
                height={geometry.plotHeight}
                key={bucket.start}
                onBlur={() => setFocusedIndex(null)}
                onFocus={() => {
                  setFocusedIndex(index);
                  setRovingIndex(index);
                }}
                onKeyDown={(event) => moveFocus(event, index)}
                onMouseEnter={() => setHoveredIndex(index)}
                ref={(node) => { hitZoneRefs.current[index] = node; }}
                role="listitem"
                tabIndex={tabbableIndex === index ? 0 : -1}
                width={zone.width}
                x={zone.x}
                y={geometry.plotTop}
              />
            ) : null;
          })}
        </g>
      </svg>
      {activeBucket && (
        <div aria-live="polite" className="usage-chart-tooltip" role="status" style={tooltipStyle}>
          <strong>{formatBucketDate(activeBucket.start, report.query.granularity, true)}</strong>
          {metric === "cost" ? (
            <div><span className="usage-tooltip-key usage-tooltip-cost" aria-hidden="true" /><b>{formatMicrodollars(activeBucket.costMicros)}</b><small>Provider cost</small></div>
          ) : (
            <>
              <div><span className="usage-tooltip-key usage-tooltip-input" aria-hidden="true" /><b>{formatTokens(activeBucket.inputTokens)}</b><small>Input tokens</small></div>
              <div><span className="usage-tooltip-key usage-tooltip-output" aria-hidden="true" /><b>{formatTokens(activeBucket.outputTokens)}</b><small>Output tokens</small></div>
            </>
          )}
          <p>{formatTokens(activeBucket.totalTokens)} total tokens · {activeBucket.providerCalls} calls</p>
        </div>
      )}
    </div>
  );
}
