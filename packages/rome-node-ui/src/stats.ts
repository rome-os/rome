// Folds `log.stats` groups into per-device series for the load chart and the counts.
import type { NodeActionResult, NodeStats } from "./protocol.js";

export const BUCKET_MS = 10 * 60 * 1000;
export const BUCKETS = 144;

export type ResultCounts = Record<NodeActionResult | "all", number>;

export interface Bucket {
  start: number;
  counts: ResultCounts;
}

export interface DeviceStats {
  buckets: Bucket[];
  counts: ResultCounts;
  /** The busiest bucket, or null without actions. */
  peak: Bucket | null;
}

const emptyCounts = (): ResultCounts => ({
  all: 0,
  running: 0,
  succeeded: 0,
  failed: 0,
  no_result: 0,
});

/** The start of the 24 h window that ends with the bucket holding `now`. */
export function windowStart(now: number): number {
  return (Math.floor(now / BUCKET_MS) + 1) * BUCKET_MS - BUCKETS * BUCKET_MS;
}

/** Splits the groups by lowercase peer id. A peer without actions is absent. */
export function statsByPeer(stats: NodeStats): Map<string, DeviceStats> {
  const count = Math.ceil((stats.until - stats.since) / stats.bucketMs);
  const byPeer = new Map<string, DeviceStats>();
  for (const group of stats.groups) {
    const peer = group.peer?.toLowerCase() ?? "";
    let device = byPeer.get(peer);
    if (!device) {
      device = {
        buckets: Array.from({ length: count }, (_, index) => ({
          start: stats.since + index * stats.bucketMs,
          counts: emptyCounts(),
        })),
        counts: emptyCounts(),
        peak: null,
      };
      byPeer.set(peer, device);
    }
    const bucket = device.buckets[group.bucket];
    if (!bucket) continue;
    bucket.counts[group.result] += group.count;
    bucket.counts.all += group.count;
    device.counts[group.result] += group.count;
    device.counts.all += group.count;
  }
  for (const device of byPeer.values())
    device.peak = device.buckets.reduce<Bucket | null>(
      (top, bucket) => (bucket.counts.all > (top?.counts.all ?? 0) ? bucket : top),
      null,
    );
  return byPeer;
}

/** Failed actions as a share of the ones that finished, or null when none finished. */
export function failureRate(counts: ResultCounts): number | null {
  const finished = counts.all - counts.running;
  return finished > 0 ? counts.failed / finished : null;
}
