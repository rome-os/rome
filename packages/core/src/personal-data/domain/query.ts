// A query over stored readings: its input, which mirrors the iPhone's live
// `health.stats`, and the rollups. Contract: docs/personal-data.md#query.

import { z } from "zod";
import { isValidTimeZone } from "../../lib/timezone.js";
import type { Resolution, Shape, SourceSpec, TypeSpec } from "./source.js";
import { typeSpec } from "./source.js";
import {
  fromWallClock,
  type Interval,
  isMidnight,
  isoInZone,
  nextPeriod,
  parseBound,
  periodStart,
  wallClock,
} from "./zoned-time.js";

export const MAX_BUCKETS = 1000;
export const DEFAULT_RECORD_LIMIT = 100;
export const MAX_RECORD_LIMIT = 500;

export type Aggregate = "sum" | "avg" | "min" | "max" | "latest";

export const queryInputSchema = z
  .object({
    source: z.string().min(1),
    types: z.array(z.string().min(1)).min(1).max(30).optional(),
    type: z.string().min(1).optional(),
    start: z.string().optional(),
    end: z.string().optional(),
    timeZone: z.string().optional(),
    interval: z.enum(["total", "hour", "day", "week", "month"]).optional(),
    aggregate: z.enum(["sum", "avg", "min", "max", "latest"]).optional(),
    unit: z.string().optional(),
    records: z
      .object({
        limit: z.number().int().positive().max(MAX_RECORD_LIMIT).optional(),
        cursor: z.string().nullish(),
      })
      .optional(),
  })
  .strict();

export type QueryInput = z.infer<typeof queryInputSchema>;

/** A stored reading, as a query reads it. */
export interface StoredPoint {
  id: number;
  type: string;
  shape: Shape;
  resolution: Resolution | null;
  startAt: number;
  endAt: number;
  tz: string;
  value: number | null;
  fields: Record<string, number> | null;
  metadata: Record<string, string> | null;
}

export interface QueryPlan {
  types: TypeSpec[];
  start: number;
  end: number;
  tz: string;
  interval: Interval;
  aggregate?: Aggregate;
  unit?: string;
  records?: { limit: number; after?: { startAt: number; id: number } };
}

/** Turns an input into a plan, or names what is wrong with it in words the Agent can act on. */
export function planQuery(
  source: SourceSpec,
  input: QueryInput,
  defaults: { tz: string; now: number },
): QueryPlan | { error: string } {
  if (input.types && input.type) return { error: "Send types or type, not both." };
  const names = input.types ?? (input.type ? [input.type] : []);
  if (names.length === 0) return { error: "types is required." };
  const types: TypeSpec[] = [];
  for (const name of names) {
    const spec = typeSpec(source, name);
    if (!spec) {
      return {
        error: `"${name}" is not a type of ${source.source}. Types: ${source.types.map((t) => t.type).join(", ")}.`,
      };
    }
    types.push(spec);
  }
  const tz = input.timeZone ?? defaults.tz;
  if (!isValidTimeZone(tz)) return { error: `timeZone "${tz}" is not an IANA time zone.` };

  let end = defaults.now;
  if (input.end !== undefined) {
    const parsed = parseBound(input.end, tz, true);
    if (parsed === undefined)
      return { error: "end must be an ISO 8601 time or a YYYY-MM-DD date." };
    end = parsed;
  }
  let start: number;
  if (input.start !== undefined) {
    const parsed = parseBound(input.start, tz, false);
    if (parsed === undefined) {
      return { error: "start must be an ISO 8601 time or a YYYY-MM-DD date." };
    }
    start = parsed;
  } else {
    // Today from midnight; with only an end, the day that ends there.
    start = periodStart(input.end === undefined ? end : end - 1, tz, "day");
  }
  if (start >= end) return { error: "start must be before end." };

  const interval = input.interval ?? "total";
  if (interval !== "total" && countPeriods(start, end, tz, interval) > MAX_BUCKETS) {
    return {
      error: `That window needs more than ${MAX_BUCKETS} ${interval} buckets. Use a larger interval or a shorter window.`,
    };
  }

  if (input.aggregate) {
    for (const spec of types) {
      const problem = aggregateProblem(spec, input.aggregate);
      if (problem) return { error: problem };
    }
  }
  if (input.unit) {
    for (const spec of types) {
      if (input.unit !== spec.unit && !spec.conversions?.some((c) => c.name === input.unit)) {
        const units = [spec.unit, ...(spec.conversions ?? []).map((c) => c.name)];
        return {
          error: `Unit "${input.unit}" does not fit ${spec.type}. Use one of: ${units.join(", ")}.`,
        };
      }
    }
  }

  const plan: QueryPlan = { types, start, end, tz, interval };
  if (input.aggregate) plan.aggregate = input.aggregate;
  if (input.unit) plan.unit = input.unit;
  if (input.records) {
    if (types.length !== 1) return { error: "records lists one type at a time: send type." };
    if (types[0].shape === "bucket") {
      return {
        error: `${types[0].type} is stored as buckets: query it with interval instead of records.`,
      };
    }
    let after: { startAt: number; id: number } | undefined;
    if (input.records.cursor) {
      after = decodeCursor(input.records.cursor);
      if (!after) return { error: "records.cursor is not a cursor this query returned." };
    }
    plan.records = {
      limit: input.records.limit ?? DEFAULT_RECORD_LIMIT,
      ...(after ? { after } : {}),
    };
  }
  return plan;
}

function aggregateProblem(spec: TypeSpec, aggregate: Aggregate): string | undefined {
  if (spec.rollup === "sum" && aggregate === "latest") {
    return `aggregate latest does not fit ${spec.type}, which is summed. Use sum, avg, min or max.`;
  }
  if (spec.rollup === "avg" && aggregate === "sum") {
    return `aggregate sum does not fit ${spec.type}, which is averaged. Use avg, min, max or latest.`;
  }
  return undefined;
}

function countPeriods(
  start: number,
  end: number,
  tz: string,
  interval: Exclude<Interval, "total">,
) {
  let count = 0;
  for (let at = periodStart(start, tz, interval); at < end; at = nextPeriod(at, tz, interval)) {
    count += 1;
    if (count > MAX_BUCKETS) break;
  }
  return count;
}

/** The output buckets of the window: each period clipped to the window. */
export function windowBuckets(plan: Pick<QueryPlan, "start" | "end" | "tz" | "interval">) {
  if (plan.interval === "total") return [{ start: plan.start, end: plan.end }];
  const buckets: { start: number; end: number }[] = [];
  for (
    let at = periodStart(plan.start, plan.tz, plan.interval);
    at < plan.end;
    at = nextPeriod(at, plan.tz, plan.interval)
  ) {
    const next = nextPeriod(at, plan.tz, plan.interval);
    buckets.push({ start: Math.max(at, plan.start), end: Math.min(next, plan.end) });
  }
  return buckets;
}

/** Whether a query can read the device's day buckets, which hold the device's
 *  own day statistics, rather than adding up hours. */
export function readsDayBuckets(
  plan: Pick<QueryPlan, "start" | "end" | "tz" | "interval">,
  now: number,
): boolean {
  if (plan.interval === "hour") return false;
  if (!isMidnight(plan.start, plan.tz)) return false;
  // An end inside a past day would count that whole day.
  return isMidnight(plan.end, plan.tz) || plan.end >= now - 60_000;
}

/**
 * One reading per day. When the device's day buckets are in the plan's zone,
 * each day is its day bucket, else its hours added up. When any of them is in
 * another zone, as when the guardian reads in another zone than the device's,
 * every day the device has a bucket for is that bucket, read as the day with
 * the same date here, and hours fill only the dates with no bucket. Mixing
 * hours split by this zone with buckets split by the device's would drop or
 * count twice the hours where the two splits meet. A device keeps only day
 * buckets for older history. `deviceOnly` says whether every day came from
 * the device, and `otherZones` names the zones read as this one.
 */
export function mergeDays(
  spec: TypeSpec,
  plan: QueryPlan,
  deviceDays: readonly StoredPoint[],
  hours: readonly StoredPoint[],
  /** The hours of a day either side of the window as well, for the device's dates. */
  nearHours: readonly StoredPoint[] = hours,
): { days: StoredPoint[]; deviceOnly: boolean; otherZones: string[] } {
  const inWindow = (at: number) => at >= plan.start && at < plan.end;
  const byDate = new Map<number, StoredPoint>();
  for (const day of deviceDays) {
    const date = wallClock(day.startAt, day.tz);
    const startAt = fromWallClock(plan.tz, date.year, date.month, date.day);
    if (!inWindow(startAt) || byDate.has(startAt)) continue;
    byDate.set(startAt, { ...day, startAt, endAt: nextPeriod(startAt, plan.tz, "day") });
  }
  // Any reading in another zone, a day bucket or an hour, means the device
  // splits days its own way, so every day here is split by its dates.
  const deviceZone = [...deviceDays, ...nearHours].some((point) => point.tz !== plan.tz);
  const fromHours = deviceZone
    ? daysByDeviceDate(spec, plan, nearHours)
    : daysFromHours(spec, plan, hours);
  const filled = fromHours.filter((day) => !byDate.has(day.startAt));
  const otherZones = deviceZone
    ? [
        ...new Set(
          [...byDate.values(), ...filled].map((day) => day.tz).filter((tz) => tz !== plan.tz),
        ),
      ]
    : [];
  return {
    days: [...byDate.values(), ...filled].sort((a, b) => a.startAt - b.startAt),
    deviceOnly: filled.length === 0,
    otherZones,
  };
}

interface Reading {
  value: number;
  min: number;
  max: number;
  count: number;
  at: number;
  fields: Record<string, number>;
}

export interface TypeResult {
  type: string;
  unit: string;
  aggregate: string;
  /** The zones of device days read as this zone's days with the same date. */
  dayZones?: string[];
  value?: number;
  count?: number;
  fields?: Record<string, number>;
  buckets?: {
    startISO: string;
    endISO: string;
    value?: number;
    count?: number;
    fields?: Record<string, number>;
  }[];
}

/**
 * Rolls one type's points up over the plan's buckets. A bucket type reads
 * `units`: the device's hour buckets, or its day buckets when
 * {@link readsDayBuckets} says so. A sample or record belongs to the bucket
 * it starts in, or ends in for a type bucketed by its end. A bucket with no
 * value is left out, never 0.
 */
export function rollUp(
  spec: TypeSpec,
  plan: QueryPlan,
  units: readonly StoredPoint[],
  /** For a bucket type: whether `units` are the device's own day buckets. */
  deviceDays = false,
): TypeResult {
  const aggregate = plan.aggregate ?? spec.rollup;
  const buckets = windowBuckets(plan);
  const inBucket = buckets.map(() => [] as StoredPoint[]);
  for (const point of units) {
    if (point.value === null && !point.fields) continue;
    const at = placedAt(spec, point);
    const index = buckets.findIndex((b) => at >= b.start && at < b.end);
    if (index >= 0) inBucket[index].push(point);
  }
  const label = aggregateLabel(spec, aggregate, plan.interval, deviceDays);
  const convert = converter(spec, plan.unit);
  const values = inBucket.map((points) => combine(spec, aggregate, points, convert));

  const result: TypeResult = { type: spec.type, unit: plan.unit ?? spec.unit, aggregate: label };
  if (plan.interval === "total") {
    Object.assign(result, values[0] ?? {});
    return result;
  }
  result.buckets = buckets.flatMap((bucket, index) => {
    const value = values[index];
    if (!value) return [];
    return [
      {
        startISO: isoInZone(bucket.start, plan.tz),
        endISO: isoInZone(bucket.end, plan.tz),
        ...value,
      },
    ];
  });
  return result;
}

function aggregateLabel(
  spec: TypeSpec,
  aggregate: Aggregate,
  interval: Interval,
  deviceDays: boolean,
): string {
  if (spec.shape !== "bucket" || aggregate !== "avg" || interval === "hour") return aggregate;
  if (interval === "day") return deviceDays ? "avg" : "avg_of_hours";
  return "avg_of_days";
}

function combine(
  spec: TypeSpec,
  aggregate: Aggregate,
  points: readonly StoredPoint[],
  convert: (value: number) => number,
): { value?: number; count?: number; fields?: Record<string, number> } | undefined {
  const readings: Reading[] = points.flatMap((point) => {
    if (point.value === null) return [];
    return [
      {
        value: point.value,
        min: point.fields?.min ?? point.value,
        max: point.fields?.max ?? point.value,
        count: 1,
        at: point.startAt,
        fields: point.fields ?? {},
      },
    ];
  });
  if (readings.length === 0) return undefined;
  const out: { value?: number; count?: number; fields?: Record<string, number> } = {};
  switch (aggregate) {
    case "sum":
      out.value = readings.reduce((total, r) => total + r.value, 0);
      break;
    case "avg":
      out.value = readings.reduce((total, r) => total + r.value, 0) / readings.length;
      break;
    case "min":
      out.value = Math.min(...readings.map((r) => r.min));
      break;
    case "max":
      out.value = Math.max(...readings.map((r) => r.max));
      break;
    case "latest":
      out.value = readings.reduce((last, r) => (r.at > last.at ? r : last)).value;
      break;
  }
  out.value = round(convert(out.value));
  // A record adds up what comes with it, such as minutes per sleep stage.
  if (spec.shape === "record") {
    out.count = readings.length;
    const fields: Record<string, number> = {};
    for (const reading of readings) {
      for (const [key, value] of Object.entries(reading.fields)) {
        fields[key] = (fields[key] ?? 0) + value;
      }
    }
    // An averaged record averages what comes with it the same way, so a
    // night's stages add up to its value.
    const per = aggregate === "avg" ? readings.length : 1;
    if (Object.keys(fields).length > 0) {
      out.fields = Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, round(v / per)]));
    }
  }
  return out;
}

/** The time that places a reading in a window and a bucket (TypeSpec.bucketBy). */
export function placedAt(spec: TypeSpec, point: Pick<StoredPoint, "startAt" | "endAt">): number {
  return spec.bucketBy === "end" ? point.endAt : point.startAt;
}

/** Adds hours up into days by the date they fall on in their own zone,
 *  each read as the day with the same date in the plan's zone. */
function daysByDeviceDate(
  spec: TypeSpec,
  plan: QueryPlan,
  hours: readonly StoredPoint[],
): StoredPoint[] {
  const days = new Map<number, StoredPoint[]>();
  for (const hour of hours) {
    if (hour.value === null) continue;
    const date = wallClock(hour.startAt, hour.tz);
    const startAt = fromWallClock(plan.tz, date.year, date.month, date.day);
    if (startAt < plan.start || startAt >= plan.end) continue;
    days.set(startAt, [...(days.get(startAt) ?? []), hour]);
  }
  return [...days.entries()].map(([startAt, list]) => dayOf(spec, plan, startAt, list));
}

/** Adds the hours of each day up into one reading per day in the plan's zone,
 *  for a bucket type whose day buckets cannot be read. */
export function daysFromHours(spec: TypeSpec, plan: QueryPlan, hours: readonly StoredPoint[]) {
  if (plan.interval === "hour") return hours;
  const days = new Map<number, StoredPoint[]>();
  for (const hour of hours) {
    if (hour.value === null) continue;
    // A window that starts mid-day starts its first day there, so the day
    // lands in the window's first bucket.
    const day = Math.max(periodStart(hour.startAt, plan.tz, "day"), plan.start);
    days.set(day, [...(days.get(day) ?? []), hour]);
  }
  return [...days.entries()].map(([dayStart, list]) => dayOf(spec, plan, dayStart, list));
}

/** One day's reading from its hours. */
function dayOf(
  spec: TypeSpec,
  plan: QueryPlan,
  dayStart: number,
  list: readonly StoredPoint[],
): StoredPoint {
  const total = list.reduce((sum, p) => sum + (p.value ?? 0), 0);
  const mins = list.map((p) => p.fields?.min ?? p.value ?? 0);
  const maxes = list.map((p) => p.fields?.max ?? p.value ?? 0);
  return {
    id: 0,
    type: spec.type,
    shape: "bucket",
    resolution: "day",
    startAt: dayStart,
    endAt: nextPeriod(periodStart(dayStart, plan.tz, "day"), plan.tz, "day"),
    tz: plan.tz,
    value: spec.rollup === "sum" ? total : total / list.length,
    // A summed day's minimum is the day's total, not its smallest hour.
    fields: spec.rollup === "sum" ? null : { min: Math.min(...mins), max: Math.max(...maxes) },
    metadata: null,
  };
}

function converter(spec: TypeSpec, unit: string | undefined): (value: number) => number {
  const conversion = unit ? spec.conversions?.find((c) => c.name === unit) : undefined;
  if (!conversion) return (value) => value;
  return (value) => value * conversion.factor + (conversion.offset ?? 0);
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** One record of a sample or record type, as a listing returns it. */
export function listedRecord(spec: TypeSpec, plan: QueryPlan, point: StoredPoint) {
  const convert = converter(spec, plan.unit);
  return {
    startISO: isoInZone(point.startAt, plan.tz),
    endISO: isoInZone(point.endAt, plan.tz),
    ...(point.value !== null ? { value: round(convert(point.value)) } : {}),
    unit: plan.unit ?? spec.unit,
    ...(point.fields ? { fields: point.fields } : {}),
    ...(point.metadata ? { metadata: point.metadata } : {}),
  };
}

export function encodeCursor(point: Pick<StoredPoint, "startAt" | "id">): string {
  return Buffer.from(`${point.startAt}:${point.id}`).toString("base64url");
}

function decodeCursor(cursor: string): { startAt: number; id: number } | undefined {
  const match = /^(\d+):(\d+)$/.exec(Buffer.from(cursor, "base64url").toString());
  return match ? { startAt: Number(match[1]), id: Number(match[2]) } : undefined;
}
