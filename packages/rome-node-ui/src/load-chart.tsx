import { useRef, useState, type KeyboardEvent } from "react";
import { cn } from "@rome-os/ui/cn";
import { clock, startOfDay } from "./format.js";
import { format, type NodeUiMessages } from "./messages.js";
import { resultPaint } from "./parts.js";
import type { Bucket } from "./stats.js";

const HOUR_MS = 60 * 60 * 1000;

/** The stacked bar of one bucket: the failed, no-result, and running shares sit on top. */
function Bar({ bucket, max, dim }: { bucket: Bucket; max: number; dim: boolean }) {
  const { counts } = bucket;
  // The transparent right border is the 1px gap between bars: the parts paint the content box.
  if (!counts.all) return <span className="h-full flex-1 border-r border-transparent" />;
  const height = Math.max(2, (counts.all / max) * 100);
  const part = (value: number) => `${(value / counts.all) * 100}%`;
  return (
    <span
      className={cn(
        "flex flex-1 flex-col justify-end overflow-hidden border-r border-transparent bg-clip-content transition-opacity",
        dim && "opacity-40",
      )}
      style={{ height: `${height}%` }}
    >
      {counts.failed > 0 && (
        <span className={resultPaint.failed} style={{ height: part(counts.failed) }} />
      )}
      {counts.no_result > 0 && (
        <span className={resultPaint.no_result} style={{ height: part(counts.no_result) }} />
      )}
      {counts.running > 0 && (
        <span className={resultPaint.running} style={{ height: part(counts.running) }} />
      )}
      <span className="flex-1 bg-muted-foreground/45" />
    </span>
  );
}

/** One line that describes a bucket, for the readout and for a bar's accessible name. */
function describeBucket(
  bucket: Bucket,
  bucketMs: number,
  m: NodeUiMessages,
  locale: string | undefined,
  countText: (count: number) => string,
): string {
  const { counts } = bucket;
  return [
    format(m.chart.readout, {
      from: clock(bucket.start, locale, false),
      to: clock(bucket.start + bucketMs, locale, false),
      count: countText(counts.all),
    }),
    counts.failed ? format(m.chart.failed, { count: counts.failed }) : null,
    counts.no_result ? format(m.chart.noResult, { count: counts.no_result }) : null,
    counts.running ? format(m.chart.running, { count: counts.running }) : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

interface LoadChartProps {
  buckets: Bucket[];
  bucketMs: number;
  m: NodeUiMessages;
  locale: string | undefined;
  size: "sm" | "lg";
  countText: (count: number) => string;
  /** Makes each bar a button that scopes the list to its bucket. */
  selected?: number | null;
  onSelect?: (start: number | null) => void;
}

/**
 * Command volume over the window, one bar per bucket, with the failed and no-result share of
 * each bar stacked on top in its result color and the average as a dashed line. The large
 * size is interactive: the arrow keys move between bars, and Enter or a click scopes the list.
 */
export function LoadChart({
  buckets,
  bucketMs,
  m,
  locale,
  size,
  countText,
  selected = null,
  onSelect,
}: LoadChartProps) {
  const [hover, setHover] = useState<number | null>(null);
  const [focus, setFocus] = useState(() => Math.max(0, buckets.length - 1));
  const bars = useRef<(HTMLButtonElement | null)[]>([]);
  const max = Math.max(1, ...buckets.map((bucket) => bucket.counts.all));
  const total = buckets.reduce((sum, bucket) => sum + bucket.counts.all, 0);
  const average = buckets.length ? total / buckets.length : 0;
  const first = buckets[0]?.start ?? 0;
  const span = buckets.length * bucketMs;
  const interactive = Boolean(onSelect);
  const selectedIndex = buckets.findIndex((bucket) => bucket.start === selected);
  const shown = hover ?? (selectedIndex >= 0 ? selectedIndex : null);

  const move = (event: KeyboardEvent) => {
    const steps: Record<string, number> = { ArrowRight: 1, ArrowLeft: -1, End: 1e6, Home: -1e6 };
    const step = steps[event.key] ?? 0;
    if (!step) return;
    event.preventDefault();
    const next = Math.min(buckets.length - 1, Math.max(0, focus + step));
    setFocus(next);
    setHover(next);
    bars.current[next]?.focus();
  };

  // Hour ticks every three hours of local time on the large chart, keeping every second one
  // when the chart is narrow, and three fixed marks on the small one.
  const midnight = startOfDay(first);
  const ticks: { at: number; label: string; minor: boolean }[] =
    size === "lg"
      ? Array.from({ length: 17 }, (_, index) => midnight + index * 3 * HOUR_MS)
          .map((at) => ({
            at: (at - first) / span,
            label: clock(at, locale, false),
            minor: new Date(at).getHours() % 6 !== 0,
          }))
          .filter((tick) => tick.at >= 0.02 && tick.at <= 0.92)
      : [
          { at: 0, label: m.chart.dayAgo, minor: false },
          { at: 0.5, label: m.chart.halfDayAgo, minor: false },
        ];

  return (
    <div className="@container flex flex-col gap-2">
      {interactive && (
        <p
          className="h-[1lh] truncate text-right font-mono text-aux text-muted-foreground"
          aria-live="polite"
        >
          {shown !== null && buckets[shown]
            ? describeBucket(buckets[shown], bucketMs, m, locale, countText)
            : null}
        </p>
      )}
      <div
        role={interactive ? "toolbar" : "img"}
        aria-label={m.chart.label}
        className={cn("relative flex items-end", size === "lg" ? "h-28" : "h-14")}
        onKeyDown={interactive ? move : undefined}
        onMouseLeave={() => setHover(null)}
      >
        {average > 0 && (
          <span
            className="pointer-events-none absolute inset-x-0 border-t border-dashed border-border-strong"
            style={{ bottom: `${(average / max) * 100}%` }}
            aria-hidden
          />
        )}
        {buckets.map((bucket, index) => {
          const dim = selectedIndex >= 0 && index !== selectedIndex;
          if (!interactive) return <Bar key={bucket.start} bucket={bucket} max={max} dim={false} />;
          return (
            <button
              key={bucket.start}
              ref={(element) => {
                bars.current[index] = element;
              }}
              type="button"
              tabIndex={index === focus ? 0 : -1}
              aria-pressed={index === selectedIndex}
              aria-label={describeBucket(bucket, bucketMs, m, locale, countText)}
              aria-disabled={!bucket.counts.all || undefined}
              onMouseEnter={() => setHover(index)}
              onFocus={() => {
                setFocus(index);
                setHover(index);
              }}
              onBlur={() => setHover(null)}
              onClick={() => {
                if (bucket.counts.all) onSelect!(index === selectedIndex ? null : bucket.start);
              }}
              className={cn(
                "relative flex h-full flex-1 cursor-pointer items-end rounded-4 outline-none outline-1 outline-offset-1 outline-transparent focus-visible:outline-solid focus-visible:outline-ring/50 aria-disabled:cursor-default",
                index === hover && "bg-surface-hover",
              )}
            >
              <Bar bucket={bucket} max={max} dim={dim} />
            </button>
          );
        })}
      </div>
      <div className="relative h-[1lh] font-mono text-aux text-muted-foreground" aria-hidden>
        {ticks.map((tick) => (
          <span
            key={tick.label}
            className={cn(
              "absolute",
              tick.at > 0 && "-translate-x-1/2",
              tick.minor && "hidden @xl:inline",
            )}
            style={{ left: `${tick.at * 100}%` }}
          >
            {tick.label}
          </span>
        ))}
        <span className="absolute right-0">{m.chart.now}</span>
      </div>
    </div>
  );
}
