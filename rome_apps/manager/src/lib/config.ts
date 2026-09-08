/** Everything `manager:setup` stores and every action reads back. */
export interface ManagerConfig {
  /** Absolute directory every worker is told to work in. */
  workingDir: string;
  /** Canonical id of the agent a worker runs. */
  workerAgent: string;
  /** Started facts one task may collect since the last person fact before the runtime asks. */
  startCap: number;
  /** Workers allowed to be running at once, across every task. */
  maxWorkers: number;
  /** Hours a worker may be silent before the runtime declares it Lost. */
  ageCapHours: number;
  /** How often the reconcile routine fires. */
  intervalMinutes: number;
}

export const DEFAULT_WORKER_AGENT = "coding:coding";
export const DEFAULT_START_CAP = 2;
export const DEFAULT_MAX_WORKERS = 3;
export const DEFAULT_AGE_CAP_HOURS = 3;
export const DEFAULT_INTERVAL_MINUTES = 5;

/** Key the single config row lives under. */
export const CONFIG_KEY = "manager_config";

/** Stable identity of the routine `manager:setup` owns. */
export const RECONCILE_ROUTINE_KEY = "manager-reconcile";
export const RECONCILE_ROUTINE_NAME = "Manager: reconcile";

export type ParseConfigResult = { ok: true; config: ManagerConfig } | { ok: false; error: string };

function positiveInt(value: unknown, fallback: number, max: number): number {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(n, max);
}

/**
 * Project a loose object onto {@link ManagerConfig}. Only `workingDir` has no
 * safe default, so it is the only field that can reject the whole config; a
 * nonsense cap degrades to its default rather than stopping the loop, because
 * the routine that reads this fires unattended.
 */
export function parseConfig(raw: unknown): ParseConfigResult {
  const args = (raw ?? {}) as Record<string, unknown>;
  const workingDir = typeof args.workingDir === "string" ? args.workingDir.trim() : "";
  if (!workingDir.startsWith("/")) {
    return {
      ok: false,
      error: `workingDir must be an absolute path; got ${JSON.stringify(args.workingDir ?? null)}. Run manager:setup first.`,
    };
  }

  const workerAgent =
    typeof args.workerAgent === "string" && args.workerAgent.trim()
      ? args.workerAgent.trim()
      : DEFAULT_WORKER_AGENT;

  return {
    ok: true,
    config: {
      workingDir,
      workerAgent,
      startCap: positiveInt(args.startCap, DEFAULT_START_CAP, 20),
      maxWorkers: positiveInt(args.maxWorkers, DEFAULT_MAX_WORKERS, 20),
      ageCapHours: positiveInt(args.ageCapHours, DEFAULT_AGE_CAP_HOURS, 168),
      intervalMinutes: normalizeIntervalMinutes(args.intervalMinutes),
    },
  };
}

/**
 * Minute cadences that survive Rome's RRULE-to-cron conversion unchanged. The
 * scheduler turns `FREQ=MINUTELY;INTERVAL=n` into a cron step field of n, so an
 * interval that does not divide the hour would drift at every hour boundary.
 */
export const INTERVAL_OPTIONS = [1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30] as const;

/** Snap an arbitrary minute count to the nearest cadence cron reproduces exactly. */
export function normalizeIntervalMinutes(raw: unknown): number {
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_INTERVAL_MINUTES;
  let best: number = INTERVAL_OPTIONS[0];
  for (const option of INTERVAL_OPTIONS) {
    if (Math.abs(option - n) < Math.abs(best - n)) best = option;
  }
  return best;
}

/** The schedule trigger `manager:setup` registers for `manager:reconcile`. */
export function reconcileTrigger(intervalMinutes: number): Record<string, unknown> {
  return {
    type: "schedule",
    tzid: "UTC",
    // Floating so the routine follows the guardian; for a MINUTELY rule the
    // scheduler ignores localTime anyway, and this keeps the shape uniform.
    tzMode: "floating",
    localTime: "00:00",
    rrule: `FREQ=MINUTELY;INTERVAL=${normalizeIntervalMinutes(intervalMinutes)}`,
  };
}
