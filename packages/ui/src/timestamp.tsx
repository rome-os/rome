import {
  createContext,
  forwardRef,
  useContext,
  useEffect,
  useReducer,
  type ComponentProps,
  type ReactNode,
} from "react";
import { cn } from "./cn.js";

/** The named layouts a `Timestamp` renders. `relative` is the live one:
 * "3 minutes ago", "yesterday", "in 2 hours", re-rendered as the clock moves. */
export type TimestampPreset = "relative" | "time" | "date" | "datetime" | "full";

/** A preset name, or raw `Intl.DateTimeFormat` options for a layout the
 * presets do not cover. Options never tick; only `relative` does. */
export type TimestampFormat = TimestampPreset | Intl.DateTimeFormatOptions;

/** Anything `new Date()` accepts, or nothing. An ISO string is the common case
 * since that is what the API returns; a number is epoch milliseconds. */
export type TimestampValue = Date | string | number | null | undefined;

export interface TimestampSettings {
  /** IANA zone every `Timestamp` below renders in, e.g. "Asia/Tokyo". A value
   * the runtime cannot resolve falls back to the browser's zone. */
  timeZone?: string;
  /** BCP 47 locale for the wording and the calendar. Defaults to the
   * runtime's locale. */
  locale?: string;
}

const TimestampContext = createContext<TimestampSettings>({});

export interface TimestampProviderProps extends TimestampSettings {
  children?: ReactNode;
}

/** Sets the zone and locale for every `Timestamp` in its subtree. A host mounts
 * one at its root with the user's configured zone; a `Timestamp` prop still
 * wins over the provider for a single element. */
export function TimestampProvider({ timeZone, locale, children }: TimestampProviderProps) {
  return (
    <TimestampContext.Provider value={{ timeZone, locale }}>{children}</TimestampContext.Provider>
  );
}

export interface ResolvedTimestampSettings {
  timeZone: string;
  locale: string | undefined;
}

/** The zone and locale a `Timestamp` at this point in the tree would use,
 * for callers that format a date some other way (an axis label, a filename)
 * and need to agree with the timestamps beside it. */
export function useTimestampSettings(): ResolvedTimestampSettings {
  const settings = useContext(TimestampContext);
  return { timeZone: resolveTimeZone(settings.timeZone), locale: settings.locale };
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const PRESETS: Record<Exclude<TimestampPreset, "relative">, Intl.DateTimeFormatOptions> = {
  time: { hour: "numeric", minute: "2-digit" },
  date: { year: "numeric", month: "short", day: "numeric" },
  datetime: { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" },
  full: {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  },
};

// Probing a zone means constructing a formatter, which is the slow part of
// Intl, and every render of every Timestamp asks about the same one or two.
const zoneValidity = new Map<string, boolean>();

function isValidTimeZone(timeZone: string): boolean {
  let valid = zoneValidity.get(timeZone);
  if (valid === undefined) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone });
      valid = true;
    } catch {
      valid = false;
    }
    zoneValidity.set(timeZone, valid);
  }
  return valid;
}

function resolveTimeZone(candidate: string | undefined): string {
  if (candidate && isValidTimeZone(candidate)) return candidate;
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function toMillis(value: TimestampValue): number | null {
  if (value === null || value === undefined) return null;
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isNaN(ms) ? null : ms;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function dateFormatter(
  locale: string | undefined,
  timeZone: string,
  options: Intl.DateTimeFormatOptions,
): Intl.DateTimeFormat {
  const key = `${locale ?? ""}|${timeZone}|${JSON.stringify(options)}`;
  let formatter = formatterCache.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(locale, { ...options, timeZone });
    formatterCache.set(key, formatter);
  }
  return formatter;
}

// Read back as numbers, so the locale only has to be one with ASCII digits.
const CALENDAR_PARTS: Intl.DateTimeFormatOptions = {
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  minute: "numeric",
  second: "numeric",
  hourCycle: "h23",
};

interface ZonedClock {
  /** Days since the epoch of the calendar day this instant falls on in the zone. */
  dayNumber: number;
  /** Milliseconds elapsed since that day's local midnight. */
  msIntoDay: number;
}

function zonedClock(ms: number, timeZone: string): ZonedClock {
  const parts = dateFormatter("en-US", timeZone, CALENDAR_PARTS).formatToParts(ms);
  const read = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value ?? 0);
  const dayNumber = Math.floor(Date.UTC(read("year"), read("month") - 1, read("day")) / DAY);
  const subSecond = ((ms % 1000) + 1000) % 1000;
  const msIntoDay = (read("hour") * 3600 + read("minute") * 60 + read("second")) * 1000 + subSecond;
  return { dayNumber, msIntoDay };
}

interface ElapsedTier {
  unit: Intl.RelativeTimeFormatUnit;
  size: number;
  /** The tier ends where the rounded count reaches this. */
  limit: number;
  /** The distance at which the tier begins, i.e. where the one below ends. */
  floor: number;
}

const ELAPSED_TIERS: readonly ElapsedTier[] = [
  { unit: "minute", size: MINUTE, limit: 60, floor: MINUTE },
  { unit: "hour", size: HOUR, limit: 24, floor: 59.5 * MINUTE },
];

interface RelativeParts {
  value: number;
  unit: Intl.RelativeTimeFormatUnit;
  /** Milliseconds until the label may read differently. */
  refreshIn: number;
}

/**
 * Splits a target instant into the (value, unit) pair `Intl.RelativeTimeFormat`
 * renders, plus how long that pair stays true.
 *
 * Under a day the tier is elapsed time, rounded to the nearest unit, so
 * "1 hour ago" covers 30 to 89 minutes. From a day up the tier is calendar
 * days in the zone: "yesterday" means the previous local date, whatever the
 * hour, so an entry from 11 pm reads "yesterday" at 1 am rather than
 * "2 hours ago" turning into "today". That is the one place the zone enters
 * relative wording, and it is why the zone is a parameter here at all.
 *
 * `refreshIn` is the distance to the next rounding point of the current tier,
 * or to the next local midnight once the tier is calendar days. For a future
 * target the distance shrinks instead of growing, so the next point is the
 * rounding point below, clamped at the tier's floor.
 */
function relativeParts(target: number, now: number, timeZone: string): RelativeParts {
  const delta = target - now;
  const abs = Math.abs(delta);
  const past = delta < 0;

  if (abs < MINUTE) {
    return { value: 0, unit: "second", refreshIn: MINUTE + delta };
  }

  for (const tier of ELAPSED_TIERS) {
    const n = Math.round(abs / tier.size);
    if (n < tier.limit) {
      const nextPoint = past ? (n + 0.5) * tier.size : Math.max((n - 0.5) * tier.size, tier.floor);
      return { value: past ? -n : n, unit: tier.unit, refreshIn: Math.abs(nextPoint - abs) };
    }
  }

  const clock = zonedClock(now, timeZone);
  const days = zonedClock(target, timeZone).dayNumber - clock.dayNumber;
  const refreshIn = DAY - clock.msIntoDay;
  const absDays = Math.abs(days);
  if (absDays < 7) return { value: days, unit: "day", refreshIn };
  if (absDays < 30) return { value: Math.round(days / 7), unit: "week", refreshIn };
  const months = Math.round(days / 30.44);
  if (Math.abs(months) < 12) return { value: months, unit: "month", refreshIn };
  return { value: Math.round(days / 365.25), unit: "year", refreshIn };
}

export interface FormatTimestampOptions {
  format?: TimestampFormat;
  timeZone?: string;
  locale?: string;
  /** The instant `relative` measures from. Defaults to `Date.now()`. */
  now?: number;
}

/** The text a `Timestamp` with the same props renders, or `null` when `value`
 * is empty or not a date. The zone falls back the same way the component's does. */
export function formatTimestamp(
  value: TimestampValue,
  options: FormatTimestampOptions = {},
): string | null {
  const ms = toMillis(value);
  if (ms === null) return null;
  const timeZone = resolveTimeZone(options.timeZone);
  const format = options.format ?? "relative";
  if (format === "relative") {
    const { value: amount, unit } = relativeParts(ms, options.now ?? Date.now(), timeZone);
    return new Intl.RelativeTimeFormat(options.locale, { numeric: "auto" }).format(amount, unit);
  }
  const dateOptions = typeof format === "string" ? PRESETS[format] : format;
  return dateFormatter(options.locale, timeZone, dateOptions).format(ms);
}

export interface TimestampProps extends Omit<ComponentProps<"time">, "dateTime" | "children"> {
  value: TimestampValue;
  /** Defaults to `relative`. */
  format?: TimestampFormat;
  /** Overrides the provider's zone for this element only. */
  timeZone?: string;
  /** Overrides the provider's locale for this element only. */
  locale?: string;
  /** Rendered when `value` is empty or not a date. Defaults to an em dash. */
  fallback?: ReactNode;
}

/**
 * An instant, rendered inline as text in the user's zone.
 *
 * Renders a `<time>` whose `dateTime` carries the ISO instant, so the machine
 * value survives whatever the visible text rounds away. Every layout but
 * `full` also gets the `full` rendering as its `title`, so hovering a relative
 * or a clock-only label shows the exact moment; pass `title` to replace that.
 *
 * `relative` schedules its own re-render for the moment the wording would
 * change and no sooner: once at the minute mark for a fresh entry, once a
 * minute after that, hourly past an hour, and at local midnight once the label
 * is a calendar day. A list of a thousand of these holds a thousand timers,
 * each idle until its own boundary.
 */
export const Timestamp = forwardRef<HTMLTimeElement, TimestampProps>(function Timestamp(
  { value, format = "relative", timeZone, locale, fallback = "—", title, className, ...rest },
  ref,
) {
  const settings = useContext(TimestampContext);
  const zone = resolveTimeZone(timeZone ?? settings.timeZone);
  const resolvedLocale = locale ?? settings.locale;
  const ms = toMillis(value);
  const live = format === "relative" && ms !== null;

  // `now` is read during render rather than kept in state so a re-render for
  // any other reason (new data, a parent update) also picks up the current
  // clock; the reducer exists only to force one at the scheduled boundary.
  const [tick, forceRender] = useReducer((n: number) => n + 1, 0);
  const now = Date.now();

  useEffect(() => {
    if (!live) return;
    const { refreshIn } = relativeParts(ms, Date.now(), zone);
    const id = setTimeout(forceRender, Math.max(refreshIn, 1000));
    return () => clearTimeout(id);
  }, [live, ms, zone, tick]);

  if (ms === null) {
    // Still a <time>, without `dateTime`, so the forwarded ref is the element
    // type the props promise whether or not the value parsed.
    return (
      <time ref={ref} title={title} className={cn("whitespace-nowrap", className)} {...rest}>
        {fallback}
      </time>
    );
  }

  const text = formatTimestamp(ms, { format, timeZone: zone, locale: resolvedLocale, now });
  const hover =
    title !== undefined
      ? title
      : format === "full"
        ? undefined
        : (formatTimestamp(ms, { format: "full", timeZone: zone, locale: resolvedLocale }) ??
          undefined);

  return (
    <time
      ref={ref}
      dateTime={new Date(ms).toISOString()}
      title={hover}
      className={cn("whitespace-nowrap tabular-nums", className)}
      {...rest}
    >
      {text}
    </time>
  );
});
