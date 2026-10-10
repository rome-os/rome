import { useMemo, useState } from "react";
import type {
  SessionMetricGroup,
  SessionMetricsBucket,
  SessionsMetric,
} from "@rome/api-types/sessions";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip as ChartTooltip,
  XAxis,
  YAxis,
} from "recharts";
import { ModelProviderIcon } from "@/components/brand-icons/ai-tool-icons";
import { cn } from "@/lib/utils";
import { formatCompactNumber, formatCost } from "./sessions-format";

const SERIES_COLORS = [
  "#bfdbfe",
  "#60a5fa",
  "#3b82f6",
  "#1d4ed8",
  "#c4b5fd",
  "#8b5cf6",
  "#a5b4fc",
  "#6366f1",
  "#7dd3fc",
  "#0ea5e9",
  "#93c5fd",
  "#4f46e5",
];

const TOTAL_LINE_COLOR = "#4f46e5";

const AUXILIARY_TICK_TEXT = {
  fill: "var(--muted-foreground)",
  fontSize: "var(--text-aux)",
  fontWeight: "var(--text-aux--font-weight)",
  letterSpacing: "var(--text-aux--letter-spacing)",
  lineHeight: "var(--text-aux--line-height)",
};

type ChartDatum = {
  bucket: string;
  total: number;
  [dataKey: string]: string | number;
};

function colorForSeries(series: SessionMetricGroup): string {
  if (series.kind === "other") return "#94a3b8";
  if (series.kind === "unknown") return "#cbd5e1";
  let hash = 0;
  for (const character of series.key) hash = (hash * 31 + character.charCodeAt(0)) | 0;
  return SERIES_COLORS[Math.abs(hash) % SERIES_COLORS.length];
}

function valueForMetric(bucket: SessionMetricsBucket["values"][number], metric: SessionsMetric) {
  if (metric === "tokens") return bucket.usage.totalTokens;
  if (metric === "cost") return bucket.usage.costUsd ?? 0;
  if (metric === "errors") return bucket.outcomes.error;
  return bucket.runCount;
}

function totalForMetric(bucket: SessionMetricsBucket, metric: SessionsMetric) {
  if (metric === "tokens") return bucket.usage.totalTokens;
  if (metric === "cost") return bucket.usage.costUsd ?? 0;
  if (metric === "errors") return bucket.outcomes.error;
  return bucket.runCount;
}

function formatMetric(value: number, metric: SessionsMetric) {
  return metric === "cost" ? formatCost(value) : formatCompactNumber(value);
}

function formatBucketLabel(value: string, includeTime = false) {
  // Bucket keys already describe the guardian's local calendar. Parse them as
  // local wall time rather than UTC so negative offsets do not shift the day.
  const normalized = value.includes("T") ? `${value}:00` : `${value}T00:00:00`;
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    ...(includeTime ? { hour: "numeric" } : {}),
  }).format(date);
}

function ModelSeriesIcon({ series }: { series: SessionMetricGroup }) {
  if (series.dimension.dimension !== "model") return null;
  const model = series.dimension;
  return (
    <ModelProviderIcon
      model={model.state === "known" ? model.name : null}
      provider={model.state === "known" ? model.provider : null}
      className="size-3.5"
      fallback="rome"
    />
  );
}

function TrendTooltip({
  active,
  bucket,
  series,
  metric,
}: {
  active?: boolean;
  bucket: SessionMetricsBucket | null;
  series: SessionMetricGroup[];
  metric: SessionsMetric;
}) {
  if (!active || !bucket) return null;
  const total = totalForMetric(bucket, metric);

  return (
    <div
      role="status"
      className="min-w-56 rounded-12 border border-border bg-popover p-3 text-aux shadow-10"
    >
      <div className="text-foreground">
        {formatBucketLabel(bucket.bucket, bucket.bucket.includes("T"))}
      </div>
      <div className="mt-1 text-muted-foreground">Total {formatMetric(total, metric)}</div>
      <div className="mt-2 space-y-2">
        {series.map((entry) => {
          const value = bucket.values.find((candidate) => candidate.key === entry.key);
          const numeric = value ? valueForMetric(value, metric) : 0;
          return (
            <div key={entry.key} className="flex items-center justify-between gap-4">
              <span className="flex min-w-0 items-center gap-2 text-muted-foreground">
                <span
                  className="size-2 shrink-0 rounded-full"
                  style={{ backgroundColor: colorForSeries(entry) }}
                />
                <ModelSeriesIcon series={entry} />
                <span className="truncate">{entry.label}</span>
              </span>
              <span className="tabular-nums text-foreground">
                {formatMetric(numeric, metric)}{" "}
                {total > 0 ? `· ${Math.round((numeric / total) * 100)}%` : ""}
              </span>
            </div>
          );
        })}
      </div>
      {metric === "tokens" ? (
        <div className="mt-2 border-t border-border-subtle pt-2 text-muted-foreground">
          Input {formatCompactNumber(bucket.usage.inputTokens)} · Output{" "}
          {formatCompactNumber(bucket.usage.outputTokens)} · Cache{" "}
          {formatCompactNumber(bucket.usage.cacheReadTokens + bucket.usage.cacheWriteTokens)}
        </div>
      ) : null}
      {metric === "cost" ? (
        <div className="mt-2 border-t border-border-subtle pt-2 text-muted-foreground">
          Known cost for {bucket.usage.costedRunCount} of {bucket.runCount} runs
        </div>
      ) : null}
    </div>
  );
}

export function SessionsTrendChart({
  buckets,
  series,
  metric,
  onSeriesSelect,
}: {
  buckets: SessionMetricsBucket[];
  series: SessionMetricGroup[];
  metric: SessionsMetric;
  onSeriesSelect: (series: SessionMetricGroup) => void;
}) {
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);
  const { data, renderedSeries } = useMemo(() => {
    const fields = series.map((entry, index) => ({
      entry,
      dataKey: `series_${index}`,
      color: colorForSeries(entry),
    }));
    const chartData = buckets.map((bucket) => {
      const values = new Map(bucket.values.map((value) => [value.key, value]));
      const datum: ChartDatum = {
        bucket: bucket.bucket,
        total: totalForMetric(bucket, metric),
      };
      for (const field of fields) {
        const value = values.get(field.entry.key);
        datum[field.dataKey] = value ? valueForMetric(value, metric) : 0;
      }
      return datum;
    });
    return { data: chartData, renderedSeries: fields };
  }, [buckets, metric, series]);

  const includesTime = buckets[0]?.bucket.includes("T") ?? false;
  const hasRuns = buckets.some((bucket) => bucket.runCount > 0);

  return (
    <div>
      <div
        className="relative mt-4 h-[12rem] w-full touch-none select-none sm:h-[14rem]"
        role="img"
        aria-label={`${metric} usage trend with ${series.length} series`}
      >
        <ResponsiveContainer
          width="100%"
          height="100%"
          minWidth={0}
          initialDimension={{ width: 1_000, height: 220 }}
        >
          <ComposedChart
            data={data}
            margin={{ top: 8, right: 8, bottom: 0, left: 0 }}
            accessibilityLayer
            onMouseLeave={() => setHoveredKey(null)}
          >
            <CartesianGrid vertical={false} stroke="var(--border)" strokeDasharray="3 5" />
            <XAxis
              dataKey="bucket"
              axisLine={false}
              tickLine={false}
              tickMargin={10}
              minTickGap={48}
              interval="preserveStartEnd"
              tick={AUXILIARY_TICK_TEXT}
              tickFormatter={(value: string) => formatBucketLabel(value, includesTime)}
            />
            <YAxis
              axisLine={false}
              tickLine={false}
              tickMargin={10}
              tickCount={3}
              // Sized from the formatted ticks: they range from "0" to "$1,045.44".
              width="auto"
              allowDecimals={metric === "cost"}
              domain={[0, (maximum: number) => (maximum > 0 ? maximum * 1.08 : 1)]}
              tick={AUXILIARY_TICK_TEXT}
              tickFormatter={(value: number) => formatMetric(value, metric)}
            />
            <ChartTooltip
              isAnimationActive={false}
              allowEscapeViewBox={{ x: false, y: true }}
              cursor={{
                stroke: "var(--border-strong)",
                strokeDasharray: "3 4",
                strokeWidth: 1,
              }}
              wrapperStyle={{ outline: "none", zIndex: 10 }}
              content={({ active, label }) => (
                <TrendTooltip
                  active={active}
                  bucket={buckets.find((bucket) => bucket.bucket === String(label ?? "")) ?? null}
                  series={series}
                  metric={metric}
                />
              )}
            />
            {renderedSeries.map(({ entry, dataKey, color }) => (
              <Area
                key={entry.key}
                dataKey={dataKey}
                name={entry.label}
                type="monotone"
                stackId="usage"
                fill={color}
                fillOpacity={hoveredKey && hoveredKey !== entry.key ? 0.2 : 0.8}
                stroke="none"
                dot={false}
                activeDot={false}
                isAnimationActive={false}
                className="cursor-pointer transition-opacity duration-150"
                onMouseEnter={() => setHoveredKey(entry.key)}
                onMouseLeave={() => setHoveredKey(null)}
                onClick={() => onSeriesSelect(entry)}
              />
            ))}
            <Line
              dataKey="total"
              type="monotone"
              stroke={TOTAL_LINE_COLOR}
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
              dot={false}
              activeDot={false}
              isAnimationActive={false}
              tooltipType="none"
              legendType="none"
              pointerEvents="none"
            />
          </ComposedChart>
        </ResponsiveContainer>
        {!hasRuns ? (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-ui text-muted-foreground">
            No runs in this period
          </div>
        ) : null}
      </div>
      <div className="mt-3 flex gap-x-5 overflow-x-auto pb-1 sm:flex-wrap sm:justify-center sm:gap-y-2">
        {series.map((entry) => (
          <button
            key={entry.key}
            type="button"
            aria-label={`Filter Sessions by ${entry.label}`}
            className={cn(
              "flex shrink-0 items-center gap-2 text-aux text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            )}
            onPointerEnter={() => setHoveredKey(entry.key)}
            onPointerLeave={() => setHoveredKey(null)}
            onFocus={() => setHoveredKey(entry.key)}
            onBlur={() => setHoveredKey(null)}
            onClick={() => onSeriesSelect(entry)}
          >
            <span
              className="size-2.5 rounded-full"
              style={{ backgroundColor: colorForSeries(entry) }}
            />
            <ModelSeriesIcon series={entry} />
            <span>{entry.label}</span>
            {entry.dimension.dimension !== "model" &&
            entry.description &&
            entry.description !== entry.label ? (
              <span className="text-muted-foreground/70">{entry.description}</span>
            ) : null}
          </button>
        ))}
      </div>
    </div>
  );
}
