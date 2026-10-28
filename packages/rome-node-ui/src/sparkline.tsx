import { Area, AreaChart, YAxis } from "recharts";
import { BUCKET_MS, type Bucket } from "./stats.js";

const HOUR_MS = 60 * 60 * 1000;

/**
 * Bottom to top: the failed commands, the ones without a result, then the rest. Only the top
 * layer draws a line, so the curve's edge is the total and the problems fill in under it.
 */
const SERIES = [
  { key: "failed", color: "var(--destructive)", line: false },
  { key: "noResult", color: "var(--warning)", line: false },
  { key: "rest", color: "var(--muted-foreground)", line: true },
] as const;

type Point = Record<(typeof SERIES)[number]["key"], number>;

/** Folds the 10-minute buckets into hours, so the curve stays readable at this size. */
function hourly(buckets: Bucket[]): Point[] {
  const size = HOUR_MS / BUCKET_MS;
  const points: Point[] = [];
  for (let index = 0; index < buckets.length; index += size) {
    const point = { rest: 0, noResult: 0, failed: 0 };
    for (const { counts } of buckets.slice(index, index + size)) {
      point.failed += counts.failed;
      point.noResult += counts.no_result;
      point.rest += counts.all - counts.failed - counts.no_result;
    }
    points.push(point);
  }
  return points;
}

/** A device's commands per hour over the last 24 hours, as a small stacked curve. */
export function Sparkline({ buckets, label }: { buckets: Bucket[]; label: string }) {
  return (
    <span role="img" aria-label={label} className="shrink-0">
      <AreaChart
        width={96}
        height={32}
        data={hourly(buckets)}
        margin={{ top: 2, right: 0, bottom: 2, left: 0 }}
        aria-hidden
      >
        {/* An idle device draws a flat line at the bottom rather than in the middle. */}
        <YAxis hide domain={[0, (max: number) => Math.max(1, max)]} />
        {SERIES.map(({ key, color, line }) => (
          <Area
            key={key}
            dataKey={key}
            stackId="commands"
            type="monotone"
            stroke={line ? color : "none"}
            strokeWidth={1.5}
            fill={color}
            fillOpacity={line ? 0.15 : 0.6}
            isAnimationActive={false}
          />
        ))}
      </AreaChart>
    </span>
  );
}
