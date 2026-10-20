import { readFileSync } from "node:fs";
import { join } from "node:path";

/** How much memory the instance can still take before it swaps or is killed. */
export interface MemoryHeadroom {
  /** Which reading supplied the numbers: the container's cgroup limit, or the
   * Linux host's `/proc/meminfo` when no cgroup limit applies. */
  source: "cgroup-v2" | "cgroup-v1" | "meminfo";
  /** The memory limit the instance runs under, in bytes. */
  limitBytes: number;
  /** Bytes still allocatable under that limit. Reclaimable file cache counts
   * as available, since the kernel drops it before it swaps anonymous memory. */
  availableBytes: number;
}

export type MemoryHeadroomReader = () => MemoryHeadroom | null;

/** The instance is short on memory while less than this share of its limit is
 * available. One line, no latch: the action engine judges each queued start
 * against a fresh reading, and the system diagnosis card paints the same line,
 * so what a guardian sees as short is exactly what holds queued work. */
export const MEMORY_HOLD_FRACTION = 0.15;

/** cgroup v1 reports "no limit" as a value near the address-space maximum. */
const CGROUP_V1_UNLIMITED = 2 ** 60;

/**
 * Reads the instance's memory headroom. A cgroup limit (v2, then v1) wins when
 * one applies and fits in the host's memory. Otherwise the Linux kernel's own
 * `MemAvailable` estimate stands in, because a hosted instance often sits at
 * the root of its cgroup namespace with the limit set a level above it, and
 * the Mac app runs core inside a Lima VM that has the same file. Returns null
 * where neither exists, such as a bare process on macOS, whose free-page count
 * would understate what is really available.
 */
export function readMemoryHeadroom(
  cgroupRoot = "/sys/fs/cgroup",
  meminfoPath = "/proc/meminfo",
): MemoryHeadroom | null {
  const host = readMeminfo(meminfoPath);
  const cgroup = readCgroupV2(cgroupRoot) ?? readCgroupV1(cgroupRoot);
  if (cgroup && (!host || cgroup.limitBytes <= host.limitBytes)) return cgroup;
  return host;
}

function readCgroupV2(root: string): MemoryHeadroom | null {
  const limit = readNumber(join(root, "memory.max"));
  const current = readNumber(join(root, "memory.current"));
  if (limit === null || current === null) return null;
  const inactiveFile = readStat(join(root, "memory.stat"), "inactive_file") ?? 0;
  return headroom("cgroup-v2", limit, current - inactiveFile);
}

function readCgroupV1(root: string): MemoryHeadroom | null {
  const limit = readNumber(join(root, "memory", "memory.limit_in_bytes"));
  const usage = readNumber(join(root, "memory", "memory.usage_in_bytes"));
  if (limit === null || usage === null || limit >= CGROUP_V1_UNLIMITED) return null;
  const inactiveFile = readStat(join(root, "memory", "memory.stat"), "total_inactive_file") ?? 0;
  return headroom("cgroup-v1", limit, usage - inactiveFile);
}

/** `/proc/meminfo` lists kB values as `MemTotal:  16318920 kB`. */
function readMeminfo(path: string): MemoryHeadroom | null {
  const text = readText(path);
  if (text === null) return null;
  const fields = new Map<string, number>();
  for (const line of text.split("\n")) {
    const match = /^(\w+):\s+(\d+)/.exec(line);
    if (match) fields.set(match[1], Number(match[2]) * 1024);
  }
  const total = fields.get("MemTotal");
  const available = fields.get("MemAvailable");
  if (total === undefined || available === undefined || !(total > 0)) return null;
  return headroom("meminfo", total, total - available);
}

function headroom(
  source: MemoryHeadroom["source"],
  limitBytes: number,
  usedBytes: number,
): MemoryHeadroom {
  return {
    source,
    limitBytes,
    availableBytes: Math.max(0, Math.min(limitBytes, limitBytes - usedBytes)),
  };
}

/** A whole number from a one-value cgroup file; null for a missing file or
 * for the literal `max`, which means no limit. */
function readNumber(path: string): number | null {
  const text = readText(path);
  if (text === null) return null;
  const value = Number(text.trim());
  return Number.isFinite(value) ? value : null;
}

function readStat(path: string, key: string): number | null {
  const text = readText(path);
  if (text === null) return null;
  for (const line of text.split("\n")) {
    const [name, value] = line.split(" ");
    if (name === key) {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : null;
    }
  }
  return null;
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}
