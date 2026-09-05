/**
 * Schedule triggers for the two routines `engineer:setup` owns. The Rome
 * scheduler converts RRULE FREQ + INTERVAL into a cron pattern, so only clean
 * MINUTELY / HOURLY / DAILY shapes translate to valid cron fields — an interval
 * that does not divide the hour is snapped to one that does.
 */

export interface ScheduleTrigger {
  type: "schedule";
  tzid: string;
  /** Floating: the routine follows the guardian's current timezone rather than pinning `tzid`. */
  tzMode: "floating";
  localTime: string;
  rrule: string;
}

/** Minute cadences that survive the RRULE-to-cron conversion unchanged. */
export const TICK_INTERVAL_OPTIONS = [5, 10, 15, 20, 30, 60, 120, 180, 360, 720, 1440] as const;

const DEFAULT_TZID = "UTC";

/** Snap an arbitrary minute count to the nearest supported, cron-clean cadence. */
export function normalizeTickMinutes(raw: unknown, fallback: number): number {
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n) || n <= 0) return fallback;
  let best: number = TICK_INTERVAL_OPTIONS[0];
  for (const option of TICK_INTERVAL_OPTIONS) {
    if (Math.abs(option - n) < Math.abs(best - n)) best = option;
  }
  return best;
}

/** Recurring trigger for `engineer:tick`, firing every `minutes` minutes. */
export function tickTrigger(minutes: number): ScheduleTrigger {
  const normalized = normalizeTickMinutes(minutes, 30);
  if (normalized % 1440 === 0) {
    return dailyTrigger("00:00");
  }
  if (normalized % 60 === 0) {
    return {
      type: "schedule",
      tzid: DEFAULT_TZID,
      tzMode: "floating",
      localTime: "00:00",
      rrule: `FREQ=HOURLY;INTERVAL=${normalized / 60}`,
    };
  }
  return {
    type: "schedule",
    tzid: DEFAULT_TZID,
    tzMode: "floating",
    localTime: "00:00",
    rrule: `FREQ=MINUTELY;INTERVAL=${normalized}`,
  };
}

/** Recurring trigger for `engineer:daily_report`, firing at the guardian's local `HH:mm`. */
export function dailyTrigger(localTime: string): ScheduleTrigger {
  return {
    type: "schedule",
    tzid: DEFAULT_TZID,
    tzMode: "floating",
    localTime,
    rrule: "FREQ=DAILY",
  };
}
