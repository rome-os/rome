import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { createTestDb, type TestDb } from "../test/db.js";
import { MAX_POINTS_PER_TYPE } from "./domain/ingest.js";
import { PersonalDataRepository } from "./repository.js";
import { APPLE_HEALTH } from "./sources/apple-health.js";
import { PERSONAL_DATA_SOURCES } from "./sources/index.js";
import {
  batch,
  DAY,
  HOUR,
  NOV_10,
  ORIGIN,
  sleepNight,
  stepHour,
  weight,
} from "./__fixtures__/apple-health.js";
import { sql } from "drizzle-orm";
import { personalDataPoints } from "../db/schema/system.js";

const NOW = NOV_10 + 2 * DAY;

describe("PersonalDataRepository", () => {
  let testDb: TestDb;
  let repo: PersonalDataRepository;

  beforeEach(() => {
    testDb = createTestDb();
    repo = new PersonalDataRepository(testDb.db, PERSONAL_DATA_SOURCES);
  });
  afterEach(() => testDb.close());

  const ingest = (envelope: ReturnType<typeof batch>, at = NOW) =>
    repo.ingest(APPLE_HEALTH, envelope, at);

  it("answers a repeated batch with the answer it got and writes nothing", () => {
    const first = ingest(batch("b-1", { upserts: [stepHour(NOV_10, 812)] }));
    expect(first.repeated).toBe(false);
    expect(first.response).toMatchObject({ status: "ok", inserted: 1, updated: 0, unchanged: 0 });

    const again = ingest(batch("b-1", { upserts: [stepHour(NOV_10, 999)] }), NOW + 1000);
    expect(again.repeated).toBe(true);
    expect(again.response).toEqual(first.response);
    const stored = testDb.db.select().from(personalDataPoints).all();
    expect(stored.map((row) => row.value)).toEqual([812]);
  });

  it("counts an unchanged item as unchanged and a changed one as updated", () => {
    ingest(batch("b-1", { upserts: [stepHour(NOV_10, 812), stepHour(NOV_10 + HOUR, 40)] }));
    const second = ingest(
      batch("b-2", { upserts: [stepHour(NOV_10, 812), stepHour(NOV_10 + HOUR, 41)] }),
    );
    expect(second.response).toMatchObject({ inserted: 0, updated: 1, unchanged: 1 });
  });

  it("deletes by key, and counts a missing key as unchanged", () => {
    ingest(batch("b-1", { upserts: [weight(NOV_10, 70.2, "w1")] }));
    const deleted = ingest(batch("b-2", { deletes: [{ key: "bodyMass:w1" }, { key: "nope" }] }));
    expect(deleted.response).toMatchObject({ deleted: 1, unchanged: 1, status: "ok" });
    expect(repo.catalog()[0].types.find((t) => t.type === "bodyMass")?.pointCount).toBe(0);
  });

  it("refuses bad items one by one and applies the rest", () => {
    const { response } = ingest(
      batch("b-1", {
        upserts: [
          stepHour(NOV_10, 812),
          { ...stepHour(NOV_10 + HOUR, 1), type: "mood" },
          { ...stepHour(NOV_10 + 2 * HOUR, 1), unit: "steps" },
          { ...stepHour(NOV_10 + 3 * HOUR, 1), end: new Date(NOV_10).toISOString() },
          { ...stepHour(NOV_10 + 4 * HOUR, 1), fields: { note: "x".repeat(5000) } },
          { ...stepHour(NOV_10 + 5 * HOUR, 1), shape: "sample" },
        ],
        deletes: [{ nokey: true }],
      }),
    );
    expect(response.status).toBe("partial");
    expect(response.inserted).toBe(1);
    expect(response.rejected.map((r) => [r.index, r.code])).toEqual([
      [1, "unknown_type"],
      [2, "bad_unit"],
      [3, "bad_range"],
      [4, "too_large"],
      [5, "bad_item"],
      [6, "bad_item"],
    ]);
  });

  it("refuses a sample over the per-type cap", () => {
    testDb.db.run(sql`
      WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${MAX_POINTS_PER_TYPE})
      INSERT INTO personal_data_points
        (source, origin, type, shape, start_at, end_at, tz, value, unit, dedupe_key, content_hash, ingest_id, updated_at)
      SELECT 'apple_health', ${ORIGIN}, 'bodyMass', 'sample', ${NOV_10} - i * 1000, ${NOV_10} - i * 1000,
        'UTC', 70, 'kg', 'bodyMass:seed-' || i, 'seed', 0, ${NOV_10}
      FROM n`);
    const { response } = ingest(
      batch("b-1", { upserts: [weight(NOV_10, 71, "new"), stepHour(NOV_10, 10)] }),
    );
    expect(response.rejected).toEqual([{ index: 0, key: "bodyMass:new", code: "type_cap" }]);
    expect(response.inserted).toBe(1);
  });

  it("keeps the catalog current: range, count and what the device reports synced", () => {
    ingest(
      batch("b-1", {
        upserts: [
          stepHour(NOV_10, 812),
          stepHour(NOV_10 + HOUR, 40),
          sleepNight(NOV_10 + 7 * HOUR, 401, 61),
        ],
        types: [{ type: "stepCount", syncedThrough: new Date(NOV_10 + 9 * HOUR).toISOString() }],
      }),
    );
    const [source] = repo.catalog();
    expect(source).toMatchObject({
      source: "apple_health",
      title: "Apple Health",
      origin: { id: ORIGIN, name: "iPhone", platform: "ios" },
      state: "active",
      lastResult: "ok",
      live: { device: "iPhone" },
    });
    expect(source.types.find((t) => t.type === "stepCount")).toEqual({
      type: "stepCount",
      shape: "bucket",
      unit: "count",
      resolutions: ["hour", "day"],
      pointCount: 2,
      earliest: new Date(NOV_10).toISOString(),
      latest: new Date(NOV_10 + 2 * HOUR).toISOString(),
      syncedThrough: new Date(NOV_10 + 9 * HOUR).toISOString(),
    });
    expect(source.types.find((t) => t.type === "sleep")?.pointCount).toBe(1);
  });

  it("never moves synced-through back, and ignores one ahead of Rome's clock", () => {
    const at = (offset: number) => new Date(NOV_10 + offset).toISOString();
    const synced = () => repo.catalog()[0].types.find((t) => t.type === "stepCount")?.syncedThrough;
    ingest(batch("b-1", { types: [{ type: "stepCount", syncedThrough: at(9 * HOUR) }] }));
    ingest(batch("b-2", { types: [{ type: "stepCount", syncedThrough: at(5 * HOUR) }] }));
    expect(synced()).toBe(at(9 * HOUR));
    ingest(batch("b-3", { types: [{ type: "stepCount", syncedThrough: at(30 * DAY) }] }));
    expect(synced()).toBe(at(9 * HOUR));
  });

  it("drops metadata keys the source does not allow", () => {
    ingest(batch("b-1", { upserts: [weight(NOV_10, 70.2, "w1")] }));
    const [row] = testDb.db.select().from(personalDataPoints).all();
    expect(row.metadata).toEqual({ sourceApp: "Health" });
  });

  it("deletes an origin's data, sets it off and keeps the log", () => {
    ingest(batch("b-1", { upserts: [stepHour(NOV_10, 812), weight(NOV_10, 70, "w1")] }));
    expect(repo.deleteOrigin("apple_health", ORIGIN, NOW + 1)).toEqual({ deletedPoints: 2 });
    const [source] = repo.catalog();
    expect(source.state).toBe("off");
    expect(source.types).toEqual([]);
    expect(repo.ingests("apple_health", 10).map((entry) => entry.status)).toEqual([
      "deleted",
      "ok",
    ]);
    expect(repo.deleteOrigin("apple_health", "unknown", NOW)).toBeUndefined();
  });

  it("sets an origin's state, and refuses one it never heard from", () => {
    ingest(batch("b-1", { upserts: [stepHour(NOV_10, 812)] }));
    expect(repo.setState("apple_health", ORIGIN, "paused")).toBe(true);
    expect(repo.catalog()[0].state).toBe("paused");
    expect(repo.setState("apple_health", "unknown", "paused")).toBe(false);
  });

  it("keeps the ingest log 90 days and never a value", () => {
    ingest(batch("b-old", { upserts: [stepHour(NOV_10, 812)] }), NOW);
    ingest(batch("b-new", { upserts: [stepHour(NOV_10 + HOUR, 5)] }), NOW + 91 * DAY);
    const log = repo.ingests("apple_health", 10);
    expect(log.map((entry) => entry.batchId)).toEqual(["b-new"]);
    expect(JSON.stringify(log)).not.toContain('"value"');
  });
});
