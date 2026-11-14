import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { createTestDb, type TestDb } from "../test/db.js";
import type { QueryInput } from "./domain/query.js";
import { type QueryAnswer, queryUserData } from "./read.js";
import { UserDataRepository } from "./repository.js";
import { APPLE_HEALTH } from "./sources/apple-health.js";
import { USER_DATA_SOURCES } from "./sources/index.js";
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

describe("queryUserData", () => {
  let testDb: TestDb;
  let repo: UserDataRepository;

  beforeEach(() => {
    testDb = createTestDb();
    repo = new UserDataRepository(testDb.db, USER_DATA_SOURCES);
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
    const answer = queryUserData(
      repo,
      APPLE_HEALTH,
      { source: "apple_health", ...input },
      { tz: TZ, now: NOW },
    );
    if ("error" in answer) throw new Error(answer.error);
    return answer;
  };
  const queryError = (input: Omit<QueryInput, "source">) => {
    const answer = queryUserData(
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

  it("adds hours up into days in another zone", () => {
    const answer = query({
      type: "stepCount",
      start: "2026-11-09",
      end: "2026-11-09",
      timeZone: "UTC",
      interval: "day",
    });
    expect(answer.results[0]).toMatchObject({
      buckets: [{ startISO: "2026-11-09T00:00:00+00:00", value: 852 }],
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
      coversWindow: true,
    });
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
    const empty = new UserDataRepository(createTestDb().db, USER_DATA_SOURCES);
    const answer = queryUserData(
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
