// Invented Apple Health batches for the personal-data tests. No real person's data.

import type { IngestEnvelope } from "../domain/ingest.js";

export const ORIGIN = "0b7e3f1c-origin-test";
export const TZ = "Asia/Shanghai";

/** 2026-11-10T00:00:00+08:00. */
export const NOV_10 = Date.parse("2026-11-09T16:00:00Z");
export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;

export function batch(
  id: string,
  items: { upserts?: unknown[]; deletes?: unknown[]; types?: IngestEnvelope["types"] } = {},
): IngestEnvelope {
  return {
    version: 1,
    source: "apple_health",
    origin: { id: ORIGIN, name: "iPhone", platform: "ios", appVersion: "1.6.0" },
    batch: { id, trigger: "observer" },
    types: items.types ?? [],
    upserts: items.upserts ?? [],
    deletes: items.deletes ?? [],
  };
}

const iso = (at: number) => new Date(at).toISOString();

export function stepHour(start: number, value: number) {
  return {
    key: `stepCount:hour:${iso(start)}`,
    type: "stepCount",
    shape: "bucket",
    resolution: "hour",
    start: iso(start),
    end: iso(start + HOUR),
    tz: TZ,
    value,
    unit: "count",
  };
}

export function stepDay(start: number, value: number) {
  return {
    key: `stepCount:day:${iso(start)}`,
    type: "stepCount",
    shape: "bucket",
    resolution: "day",
    start: iso(start),
    end: iso(start + DAY),
    tz: TZ,
    value,
    unit: "count",
  };
}

export function heartDay(start: number, value: number, low: number, high: number) {
  return {
    key: `heartRate:day:${iso(start)}`,
    type: "heartRate",
    shape: "bucket",
    resolution: "day",
    start: iso(start),
    end: iso(start + DAY),
    tz: TZ,
    value,
    unit: "count/min",
    fields: { min: low, max: high },
  };
}

export function sleepNight(wake: number, asleep: number, deep: number) {
  return {
    key: `sleep:night:${iso(wake)}`,
    type: "sleep",
    shape: "record",
    start: iso(wake - 8 * HOUR),
    end: iso(wake),
    tz: TZ,
    value: asleep,
    unit: "min",
    fields: { deep, rem: 90 },
  };
}

export function weight(at: number, kg: number, id: string) {
  return {
    key: `bodyMass:${id}`,
    type: "bodyMass",
    shape: "sample",
    start: iso(at),
    end: iso(at),
    tz: TZ,
    value: kg,
    unit: "kg",
    metadata: { sourceApp: "Health", device: "dropped" },
  };
}
