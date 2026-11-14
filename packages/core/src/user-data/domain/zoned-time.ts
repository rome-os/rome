// Calendar arithmetic in an IANA zone, for the windows and buckets of a query.
// Times are milliseconds since the epoch.

export type Interval = "total" | "hour" | "day" | "week" | "month";

interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let found = formatters.get(tz);
  if (!found) {
    found = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(tz, found);
  }
  return found;
}

export function wallClock(at: number, tz: string): WallClock {
  const parts = Object.fromEntries(
    formatter(tz)
      .formatToParts(new Date(at))
      .map((part) => [part.type, part.value]),
  );
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

/** The zone's offset from UTC at `at`, in milliseconds. */
function offsetAt(at: number, tz: string): number {
  const clock = wallClock(at, tz);
  const asUtc = Date.UTC(
    clock.year,
    clock.month - 1,
    clock.day,
    clock.hour,
    clock.minute,
    clock.second,
  );
  return asUtc - Math.floor(at / 1000) * 1000;
}

/** The instant a wall-clock time names in `tz`. Fields out of range roll over,
 *  as `Date.UTC` rolls them. A time a daylight saving change skips reads as the
 *  instant after the change. */
export function fromWallClock(
  tz: string,
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
): number {
  const guess = Date.UTC(year, month - 1, day, hour, minute, second);
  // Two passes: the offset at the guess, then at the corrected instant, so a
  // time near a daylight saving change lands on the right side of it.
  const first = guess - offsetAt(guess, tz);
  return guess - offsetAt(first, tz);
}

/** The start of the period of `interval` that holds `at`. Weeks start on Monday. */
export function periodStart(at: number, tz: string, interval: Exclude<Interval, "total">): number {
  const clock = wallClock(at, tz);
  switch (interval) {
    case "hour":
      return fromWallClock(tz, clock.year, clock.month, clock.day, clock.hour);
    case "day":
      return fromWallClock(tz, clock.year, clock.month, clock.day);
    case "week": {
      const weekday = new Date(Date.UTC(clock.year, clock.month - 1, clock.day)).getUTCDay();
      const back = (weekday + 6) % 7;
      return fromWallClock(tz, clock.year, clock.month, clock.day - back);
    }
    case "month":
      return fromWallClock(tz, clock.year, clock.month, 1);
  }
}

/** The start of the period after the one that starts at `start`. */
export function nextPeriod(
  start: number,
  tz: string,
  interval: Exclude<Interval, "total">,
): number {
  if (interval === "hour") return start + 3_600_000;
  const clock = wallClock(start, tz);
  if (interval === "day") return fromWallClock(tz, clock.year, clock.month, clock.day + 1);
  if (interval === "week") return fromWallClock(tz, clock.year, clock.month, clock.day + 7);
  return fromWallClock(tz, clock.year, clock.month + 1, 1);
}

export function isMidnight(at: number, tz: string): boolean {
  return periodStart(at, tz, "day") === at;
}

/** `at` as ISO 8601 with the zone's offset, such as `2026-11-01T00:00:00+08:00`. */
export function isoInZone(at: number, tz: string): string {
  const clock = wallClock(at, tz);
  const offsetMinutes = Math.round(offsetAt(at, tz) / 60_000);
  const sign = offsetMinutes < 0 ? "-" : "+";
  const abs = Math.abs(offsetMinutes);
  const pad = (n: number, width = 2) => String(n).padStart(width, "0");
  return (
    `${pad(clock.year, 4)}-${pad(clock.month)}-${pad(clock.day)}T` +
    `${pad(clock.hour)}:${pad(clock.minute)}:${pad(clock.second)}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const LOCAL_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

/**
 * Reads a window bound: an ISO 8601 time with an offset, a local time without
 * one (in `tz`), or a `YYYY-MM-DD` date in `tz`. A date given as an end means
 * the end of that day. Undefined for text that is none of these, or a date
 * that does not exist.
 */
export function parseBound(text: string, tz: string, endOfDay: boolean): number | undefined {
  const date = DATE_ONLY.exec(text);
  if (date) {
    const [year, month, day] = date.slice(1).map(Number);
    const check = new Date(Date.UTC(year, month - 1, day));
    if (check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return undefined;
    return fromWallClock(tz, year, month, endOfDay ? day + 1 : day);
  }
  const local = LOCAL_TIME.exec(text);
  if (local) {
    const [year, month, day, hour, minute] = local.slice(1, 6).map(Number);
    return fromWallClock(tz, year, month, day, hour, minute, Number(local[6] ?? 0));
  }
  const parsed = Date.parse(text);
  return Number.isNaN(parsed) ? undefined : parsed;
}
