import { existsSync, readFileSync } from "node:fs";
import { readEnvInstanceSlug } from "./instance-env.js";

export function runningInsideDocker(): boolean {
  return existsSync("/.dockerenv");
}

/**
 * The instance slug — the stable, DNS-label-safe identifier for this instance.
 * Sourced from `PANTHEON_SLUG`, the single slug env var: in prod it's the
 * Rome-Cloud-injected tenant slug, in dev the local Rome Cloud tenant (`dev`). Also
 * serves as telemetry's `service.instance.id`.
 *
 * Returns `undefined` when unset or blank so callers can distinguish "this
 * instance has no slug" from a real value — important for rollout gating, where
 * collapsing every un-slugged instance into one shared bucket would make them
 * all flip together.
 */
export function resolveInstanceSlug(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return readEnvInstanceSlug(env);
}

/**
 * Milliseconds since PID 1 started, which inside Docker is the container's
 * init, or null when `/proc` cannot be read. On a bare Linux host PID 1 is the
 * host's init, so the value is close to the system uptime. Assumes the
 * kernel's 100 Hz clock tick, which every Linux build Rome ships on uses.
 */
export function containerUptimeMs(
  read: (path: string) => string = (path) => readFileSync(path, "utf-8"),
): number | null {
  try {
    const systemUptimeSec = Number.parseFloat(read("/proc/uptime").split(" ")[0] ?? "");
    // Field 22 of /proc/<pid>/stat is the start time in clock ticks since boot.
    // The command name in field 2 can contain spaces, so count from its ")".
    const stat = read("/proc/1/stat");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const startTicks = Number.parseInt(fields[19] ?? "", 10);
    if (!Number.isFinite(systemUptimeSec) || !Number.isFinite(startTicks)) return null;
    return Math.round(systemUptimeSec * 1000 - startTicks * 10);
  } catch {
    return null;
  }
}
