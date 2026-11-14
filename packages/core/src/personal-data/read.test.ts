import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { createTestDb, type TestDb } from "../test/db.js";
import type { QueryInput } from "./domain/query.js";
import { type QueryAnswer, queryPersonalData } from "./read.js";
import { PersonalDataRepository } from "./repository.js";
import { APPLE_HEALTH } from "./sources/apple-health.js";
import { PERSONAL_DATA_SOURCES } from "./sources/index.js";
import {
  batch,
  DAY,
  HOUR,
  heartDay,
  NOV_10,
  sleepNight,
  stepDay,
  stepHour,
  TZ,
  weight,
} from "./__fixtures__/apple-health.js";

const NOW = NOV_10 + 5 * DAY + 10 * HOUR;

describe("queryPersonalData", () => {
  let testDb: TestDb;
  let repo: PersonalDataRepository;

  beforeEach(() => {
    testDb = createTestDb();
    repo = new PersonalDataRepository(testDb.db, PERSONAL_DATA_SOURCES);
    repo.ingest(
      APPLE_HEALTH,
      batch("seed", {
        upserts: [
          stepHour(NOV_10, 812),
          stepHour(NOV_10 + HOUR, 40),
          stepDay(NOV_10, 8000),
          stepDay(NOV_10 + DAY, 6000),
          heartDay(NOV_10, 70, 50, 120),
          heartDay(NOV_10 + DAY, 80, 55, 140),
          sleepNight(NOV_10 + DAY + 7 * HOUR, 400, 60),
          sleepNight(NOV_10 + 2 * DAY + 7 * HOUR, 420, 70),
          weight(NOV_10 + 8 * HOUR, 70, "w1"),
          weight(NOV_10 + DAY + 8 * HOUR, 69.5, "w2"),
        ],
        types: [{ type: "stepCount", syncedThrough: new Date(NOV_10 + 2 * DAY).toISOString() }],
      }),
      NOW,
    );
  });
  afterEach(() => testDb.close());

  const query = (input: Omit<QueryInput, "source">): QueryAnswer => {
    const answer = queryPersonalData(
      repo,
      APPLE_HEALTH,
      { source: "apple_health", ...input },
      { tz: TZ, now: NOW },
    );
    if ("error" in answer) throw new Error(answer.error);
    return answer;
  };
  const queryError = (input: Omit<QueryInput, "source">) => {
    const answer = queryPersonalData(
      repo,
      APPLE_HEALTH,
      { source: "apple_health", ...input },
      { tz: TZ, now: NOW },
    );
    return "error" in answer ? answer.error : undefined;
  };

  it("reads the phone's day buckets when the zone is the phone's", () => {
    const answer = query({
      type: "stepCount",
      start: "2026-11-10",
      end: "2026-11-11",
      interval: "day",
    });
    expect(answer.startISO).toBe("2026-11-10T00:00:00+08:00");
    expect(answer.endISO).toBe("2026-11-12T00:00:00+08:00");
    expect(answer.results[0]).toEqual({
      type: "stepCount",
      unit: "count",
      aggregate: "sum",
      buckets: [
        { startISO: "2026-11-10T00:00:00+08:00", endISO: "2026-11-11T00:00:00+08:00", value: 8000 },
        { startISO: "2026-11-11T00:00:00+08:00", endISO: "2026-11-12T00:00:00+08:00", value: 6000 },
      ],
    });
  });

  it("reads the device's dates in another zone, its hours included", () => {
    // The Nov 10 Shanghai hours fall on Nov 9 in UTC, but they are the device's Nov 10.
    const nov9 = query({
      type: "stepCount",
      start: "2026-11-09",
      end: "2026-11-09",
      timeZone: "UTC",
    });
    expect(nov9.results[0]).not.toHaveProperty("value");
    const nov10 = query({
      type: "stepCount",
      start: "2026-11-10",
      end: "2026-11-10",
      timeZone: "UTC",
      interval: "day",
    });
    expect(nov10.results[0]).toMatchObject({
      dayZones: [TZ],
      buckets: [{ startISO: "2026-11-10T00:00:00+00:00", value: 8000 }],
    });
  });

  it("totals a window, and leaves out a bucket with no value instead of 0", () => {
    expect(
      query({ type: "stepCount", start: "2026-11-10", end: "2026-11-11" }).results[0],
    ).toMatchObject({
      value: 14000,
    });
    const days = query({
      type: "stepCount",
      start: "2026-11-10",
      end: "2026-11-13",
      interval: "day",
    });
    expect((days.results[0] as { buckets: unknown[] }).buckets).toHaveLength(2);
  });

  it("rolls a week of an averaged type up as the mean of daily averages, with exact extremes", () => {
    const window = {
      type: "heartRate",
      start: "2026-11-09",
      end: "2026-11-15",
      interval: "week" as const,
    };
    expect(query(window).results[0]).toMatchObject({
      aggregate: "avg_of_days",
      buckets: [{ startISO: "2026-11-09T00:00:00+08:00", value: 75 }],
    });
    expect(query({ ...window, aggregate: "min" }).results[0]).toMatchObject({
      buckets: [{ value: 50 }],
    });
    expect(query({ ...window, aggregate: "max" }).results[0]).toMatchObject({
      buckets: [{ value: 140 }],
    });
  });

  it("adds records up with what comes with them", () => {
    expect(query({ type: "sleep", start: "2026-11-10", end: "2026-11-12" }).results[0]).toEqual({
      type: "sleep",
      unit: "min",
      aggregate: "sum",
      value: 820,
      count: 2,
      fields: { deep: 130, rem: 180 },
    });
  });

  it("places a night of sleep on the day it ends, by its wake date", () => {
    // 23:30 on Nov 12 to 07:00 on Nov 13, Shanghai time.
    const wake = NOV_10 + 3 * DAY + 7 * HOUR;
    repo.ingest(
      APPLE_HEALTH,
      batch("late-night", {
        upserts: [
          { ...sleepNight(wake, 390, 50), start: new Date(wake - 7.5 * HOUR).toISOString() },
        ],
      }),
      NOW,
    );
    expect(
      query({ type: "sleep", start: "2026-11-13", end: "2026-11-13" }).results[0],
    ).toMatchObject({
      value: 390,
      count: 1,
    });
    const days = query({ type: "sleep", start: "2026-11-11", end: "2026-11-13", interval: "day" });
    expect(
      (days.results[0] as { buckets: { startISO: string; value: number }[] }).buckets.map((b) => [
        b.startISO.slice(0, 10),
        b.value,
      ]),
    ).toEqual([
      ["2026-11-11", 400],
      ["2026-11-12", 420],
      ["2026-11-13", 390],
    ]);
  });

  it("averages what comes with a record when it averages the record", () => {
    expect(
      query({ type: "sleep", start: "2026-11-10", end: "2026-11-12", aggregate: "avg" }).results[0],
    ).toMatchObject({ value: 410, count: 2, fields: { deep: 65, rem: 90 } });
  });

  it("adds up hours for a day the device sent no day bucket for", () => {
    const nov12 = NOV_10 + 2 * DAY;
    repo.ingest(
      APPLE_HEALTH,
      batch("hours-only", { upserts: [stepHour(nov12, 300), stepHour(nov12 + HOUR, 200)] }),
      NOW,
    );
    const days = query({
      type: "stepCount",
      start: "2026-11-10",
      end: "2026-11-12",
      interval: "day",
    });
    expect(days.results[0]).toMatchObject({
      aggregate: "sum",
      buckets: [{ value: 8000 }, { value: 6000 }, { value: 500 }],
    });
  });

  it("reads each type from the origin that covers it furthest", () => {
    const later = new Date(NOW).toISOString();
    repo.ingest(
      APPLE_HEALTH,
      {
        ...batch("ipad-1", {
          upserts: [stepDay(NOV_10, 100)],
          types: [{ type: "stepCount", syncedThrough: later }],
        }),
        origin: { id: "second-origin", name: "iPad", platform: "ios" },
      },
      NOW,
    );
    expect(
      query({ type: "stepCount", start: "2026-11-10", end: "2026-11-10" }).results[0],
    ).toMatchObject({
      value: 100,
    });
    // The first origin still answers for the types only it has.
    expect(
      query({ type: "sleep", start: "2026-11-10", end: "2026-11-12" }).results[0],
    ).toMatchObject({
      value: 820,
    });
  });

  it("keeps reading the older origin for a window a new one has not backfilled yet", () => {
    // A new origin mid-backfill: it has reached Nov 11 and reports itself synced to now.
    repo.ingest(
      APPLE_HEALTH,
      {
        ...batch("new-1", {
          upserts: [stepDay(NOV_10 + DAY, 6100)],
          types: [{ type: "stepCount", syncedThrough: new Date(NOW).toISOString() }],
        }),
        origin: { id: "backfilling-origin", name: "iPhone", platform: "ios" },
      },
      NOW,
    );
    // The window from Nov 10 reaches past the new origin's earliest day: the old one answers.
    expect(
      query({ type: "stepCount", start: "2026-11-10", end: "2026-11-11" }).results[0],
    ).toMatchObject({ value: 14000 });
    // A window the new origin covers reads the new one.
    expect(
      query({ type: "stepCount", start: "2026-11-11", end: "2026-11-11" }).results[0],
    ).toMatchObject({ value: 6100 });
  });

  it("keeps the hours of a window that starts mid-day", () => {
    // 00:00 and 01:00 hours of Nov 10: a window from 01:00 holds the second.
    expect(
      query({ type: "stepCount", start: "2026-11-10T01:00", end: "2026-11-10T03:00" }).results[0],
    ).toMatchObject({ value: 40 });
    const days = query({
      type: "stepCount",
      start: "2026-11-10T00:30",
      end: "2026-11-10T03:00",
      interval: "day",
    });
    expect(days.results[0]).toMatchObject({
      buckets: [{ startISO: "2026-11-10T00:30:00+08:00", value: 40 }],
    });
  });

  it("takes the latest hour of an averaged type, not a day's average", () => {
    const hour = (start: number, value: number) => ({
      key: `heartRate:hour:${start}`,
      type: "heartRate",
      shape: "bucket",
      resolution: "hour",
      start: new Date(start).toISOString(),
      end: new Date(start + HOUR).toISOString(),
      tz: TZ,
      value,
      unit: "count/min",
    });
    repo.ingest(
      APPLE_HEALTH,
      batch("hr-hours", { upserts: [hour(NOV_10 + 8 * HOUR, 60), hour(NOV_10 + 9 * HOUR, 100)] }),
      NOW,
    );
    expect(
      query({ type: "heartRate", start: "2026-11-10", end: "2026-11-10", aggregate: "latest" })
        .results[0],
    ).toMatchObject({ aggregate: "latest", value: 100 });
  });

  it("reads older day-only history in another zone by its dates, and says which zone", () => {
    // The phone keeps day buckets alone for older history; the guardian reads in Los Angeles.
    const days = query({
      type: "stepCount",
      start: "2026-11-10",
      end: "2026-11-11",
      timeZone: "America/Los_Angeles",
      interval: "day",
    });
    expect(days.results[0]).toMatchObject({
      dayZones: [TZ],
      buckets: [
        { startISO: "2026-11-10T00:00:00-08:00", value: 8000 },
        { startISO: "2026-11-11T00:00:00-08:00", value: 6000 },
      ],
    });
    expect(
      query({
        type: "stepCount",
        start: "2026-11-10",
        end: "2026-11-11",
        timeZone: "America/Los_Angeles",
      }).results[0],
    ).toMatchObject({ value: 14000 });
  });

  it("splits every day by the device's dates in another zone, so no hour is counted twice", () => {
    // The Nov 10 hours (Shanghai) fall on Nov 9 in Los Angeles, inside the Nov 10 day bucket.
    const answer = query({
      type: "stepCount",
      start: "2026-11-09",
      end: "2026-11-11",
      timeZone: "America/Los_Angeles",
    });
    expect(answer.results[0]).toMatchObject({ value: 14000, dayZones: [TZ] });
  });

  it("fills a device date with no day bucket from its hours, by the device's date", () => {
    const nov12 = NOV_10 + 2 * DAY;
    repo.ingest(
      APPLE_HEALTH,
      batch("hours-only", { upserts: [stepHour(nov12, 300), stepHour(nov12 + HOUR, 200)] }),
      NOW,
    );
    const days = query({
      type: "stepCount",
      start: "2026-11-10",
      end: "2026-11-12",
      timeZone: "America/Los_Angeles",
      interval: "day",
    });
    expect(
      (days.results[0] as { buckets: { startISO: string; value: number }[] }).buckets.map((b) => [
        b.startISO.slice(0, 10),
        b.value,
      ]),
    ).toEqual([
      ["2026-11-10", 8000],
      ["2026-11-11", 6000],
      ["2026-11-12", 500],
    ]);
  });

  it("counts every hour of an edge date read by the device's date", () => {
    // Shanghai Nov 12 has hours only, from 00:00 to 02:00: in Los Angeles that is Nov 11 08:00-10:00.
    const nov12 = NOV_10 + 2 * DAY;
    repo.ingest(
      APPLE_HEALTH,
      batch("edge-hours", { upserts: [stepHour(nov12, 300), stepHour(nov12 + HOUR, 200)] }),
      NOW,
    );
    // The Los Angeles window Nov 12 starts after those hours, yet they are Shanghai Nov 12's.
    expect(
      query({
        type: "stepCount",
        start: "2026-11-12",
        end: "2026-11-12",
        timeZone: "America/Los_Angeles",
      }).results[0],
    ).toMatchObject({ value: 500 });
  });

  it("says where hourly detail starts, and does not claim an hourly window before it", () => {
    const answer = query({
      type: "stepCount",
      start: "2026-11-09T00:00",
      end: "2026-11-09T06:00",
      interval: "hour",
    });
    expect((answer.results[0] as { buckets: unknown[] }).buckets).toEqual([]);
    expect(answer.freshness.stepCount).toMatchObject({
      hourlyFrom: new Date(NOV_10).toISOString(),
      coversWindow: false,
      missingFrom: new Date(NOV_10 - DAY).toISOString(),
    });
  });

  it("converts units and takes the latest sample", () => {
    expect(
      query({
        type: "bodyMass",
        start: "2026-11-10",
        end: "2026-11-12",
        aggregate: "latest",
        unit: "lb",
      }).results[0],
    ).toMatchObject({ unit: "lb", value: 153.221 });
  });

  it("lists records a page at a time", () => {
    const first = query({
      type: "sleep",
      start: "2026-11-10",
      end: "2026-11-12",
      records: { limit: 1 },
    });
    const page = first.results[0] as { records: { value: number }[]; nextCursor?: string };
    expect(page.records.map((r) => r.value)).toEqual([400]);
    expect(page.nextCursor).toBeDefined();
    const second = query({
      type: "sleep",
      start: "2026-11-10",
      end: "2026-11-12",
      records: { limit: 1, cursor: page.nextCursor },
    });
    const next = second.results[0] as { records: { value: number }[]; nextCursor?: string };
    expect(next.records.map((r) => r.value)).toEqual([420]);
    expect(next.nextCursor).toBeUndefined();
  });

  it("says how far each type is synced and whether that covers the window", () => {
    const covered = query({ type: "stepCount", start: "2026-11-10", end: "2026-11-11" });
    expect(covered.freshness.stepCount).toEqual({
      syncedThrough: new Date(NOV_10 + 2 * DAY).toISOString(),
      earliest: new Date(NOV_10).toISOString(),
      hourlyFrom: new Date(NOV_10).toISOString(),
      coversWindow: true,
    });
    // History before the earliest reading is not known to be on Rome.
    expect(
      query({ type: "stepCount", start: "2026-11-01", end: "2026-11-11" }).freshness.stepCount,
    ).toMatchObject({ coversWindow: false, missingFrom: new Date(NOV_10 - 9 * DAY).toISOString() });
    const uncovered = query({
      types: ["stepCount", "heartRate"],
      start: "2026-11-10",
      end: "2026-11-13",
    });
    expect(uncovered.freshness.stepCount).toMatchObject({
      coversWindow: false,
      missingFrom: new Date(NOV_10 + 2 * DAY).toISOString(),
    });
    expect(uncovered.freshness.heartRate).toMatchObject({ coversWindow: false });
  });

  it("refuses inputs it cannot answer, in words the Agent can act on", () => {
    expect(queryError({ type: "heartRate", aggregate: "sum" })).toContain("does not fit heartRate");
    expect(queryError({ type: "stepCount", aggregate: "latest" })).toContain(
      "does not fit stepCount",
    );
    expect(queryError({ type: "mood" })).toContain('"mood" is not a type');
    expect(queryError({ type: "stepCount", unit: "km" })).toContain('Unit "km" does not fit');
    expect(queryError({ type: "stepCount", start: "2020-01-01", interval: "hour" })).toContain(
      "more than 1000",
    );
    expect(queryError({ type: "stepCount", records: {} })).toContain("stored as buckets");
    expect(queryError({ type: "stepCount", start: "2026-02-30" })).toContain("start must be");
  });

  it("answers a store with no data with no values", () => {
    const empty = new PersonalDataRepository(createTestDb().db, PERSONAL_DATA_SOURCES);
    const answer = queryPersonalData(
      empty,
      APPLE_HEALTH,
      { source: "apple_health", type: "stepCount" },
      { tz: TZ, now: NOW },
    );
    expect(answer).toMatchObject({
      results: [{ type: "stepCount", unit: "count", aggregate: "sum" }],
      freshness: { stepCount: { coversWindow: false } },
    });
    expect((answer as QueryAnswer).results[0]).not.toHaveProperty("value");
  });
});
