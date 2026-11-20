// The machine's memory around each rule. Rome holds queued message turns
// while the machine is short on memory and logs a warning, so a rule that ran
// through such a spell measured the machine, not the product.

import { readFileSync } from "node:fs";

// Rome's warning: "instance short on memory; holding queued roots".
const SHORT = /short on memory/i;

/** Available and total memory on this machine, from /proc/meminfo; null where it cannot be read. */
export function hostMemory() {
  try {
    const info = readFileSync("/proc/meminfo", "utf8");
    const kb = (key) => Number(info.match(new RegExp(`^${key}:\\s+(\\d+)`, "m"))?.[1]);
    const available = kb("MemAvailable");
    const total = kb("MemTotal");
    if (!available || !total) return null;
    return {
      at: new Date().toISOString(),
      availableMiB: Math.round(available / 1024),
      totalMiB: Math.round(total / 1024),
      availablePercent: Math.round((available / total) * 100),
    };
  } catch {
    return null;
  }
}

/** Per instance, its log lines that warn of short memory; null for an instance whose logs cannot be read. */
export async function shortOnMemory(instances) {
  const out = {};
  for (const inst of instances) {
    const lines = await inst.logs().catch(() => null);
    out[inst.name] = lines ? lines.filter((l) => SHORT.test(l)) : null;
  }
  return out;
}

/** The warnings in `after` that were not in `before`: those logged during the rule. */
export function warnedDuring(before, after) {
  const out = {};
  for (const [name, lines] of Object.entries(after)) {
    if (!lines) continue;
    const seen = new Set(before[name] ?? []);
    const fresh = lines.filter((l) => !seen.has(l));
    if (fresh.length) out[name] = fresh.slice(-5);
  }
  return out;
}
