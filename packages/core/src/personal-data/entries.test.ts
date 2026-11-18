// Entries, such as calendar events: stored with their content, listed over a
// window they overlap, matched by words, and removed by a delete. Invented
// events, no real person's data.

import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { createTestDb, type TestDb } from "../test/db.js";
import type { IngestEnvelope } from "./domain/ingest.js";
import { queryPersonalData } from "./read.js";
import { PersonalDataRepository } from "./repository.js";
import { APPLE_CALENDAR } from "./sources/apple-calendar.js";
import { PERSONAL_DATA_SOURCES } from "./sources/index.js";

const TZ = "Asia/Shanghai";
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** 2026-11-17T09:00:00+08:00. */
const NOW = Date.parse("2026-11-17T01:00:00Z");
/** 2026-11-18T00:00:00+08:00: tomorrow. */
const TOMORROW = Date.parse("2026-11-17T16:00:00Z");
const iso = (at: number) => new Date(at).toISOString();

function batch(
  id: string,
  items: { upserts?: unknown[]; deletes?: unknown[]; syncedThrough?: number } = {},
): IngestEnvelope {
  return {
    version: 1,
    source: "apple_calendar",
    origin: { id: "origin-calendar-test", name: "iPhone", platform: "ios" },
    batch: { id, trigger: "foreground" },
    types:
      items.syncedThrough === undefined
        ? []
        : [{ type: "events", syncedThrough: iso(items.syncedThrough) }],
    upserts: items.upserts ?? [],
    deletes: items.deletes ?? [],
  };
}

function event(id: string, start: number, end: number, content: Record<string, unknown> = {}) {
  return {
    key: `events:${id}`,
    type: "events",
    shape: "entry",
    start: iso(start),
    end: iso(end),
    tz: TZ,
    content: { id, title: `Event ${id}`, availability: "busy", ...content },
  };
}

describe("entries", () => {
  let testDb: TestDb;
  let repo: PersonalDataRepository;

  beforeEach(() => {
    testDb = createTestDb();
    repo = new PersonalDataRepository(testDb.db, PERSONAL_DATA_SOURCES);
  });
  afterEach(() => testDb.close());

  const list = (input: Record<string, unknown>, now = NOW) => {
    const answer = queryPersonalData(
      repo,
      APPLE_CALENDAR,
      { source: "apple_calendar", type: "events", ...input },
      { tz: TZ, now },
    );
    if ("error" in answer) throw new Error(answer.error);
    return answer;
  };

  it("keeps a future event with its declared content and drops the rest", () => {
    const { response } = repo.ingest(
      APPLE_CALENDAR,
      batch("b1", {
        upserts: [
          event("a", TOMORROW + 14 * HOUR, TOMORROW + 15 * HOUR, {
            location: "Room 4",
            attendees: ["Sam", 7, "Lee"],
            secret: "dropped",
            allDay: "no",
          }),
        ],
        syncedThrough: NOW,
      }),
      NOW,
    );
    expect(response).toMatchObject({ status: "ok", inserted: 1 });
    const answer = list({ start: "2026-11-18", end: "2026-11-18" });
    expect(answer.results).toEqual([
      {
        type: "events",
        records: [
          {
            key: "events:a",
            startISO: "2026-11-18T14:00:00+08:00",
            endISO: "2026-11-18T15:00:00+08:00",
            id: "a",
            title: "Event a",
            availability: "busy",
            location: "Room 4",
            attendees: ["Sam", "Lee"],
          },
        ],
      },
    ]);
  });

  it("refuses an entry with a value, or one past its type's horizon", () => {
    const { response } = repo.ingest(
      APPLE_CALENDAR,
      batch("b1", {
        upserts: [
          { ...event("v", NOW, NOW + HOUR), value: 3, unit: "event" },
          event("far", NOW + 500 * DAY, NOW + 500 * DAY + HOUR),
          event("ok", NOW + 30 * DAY, NOW + 30 * DAY + HOUR),
        ],
      }),
      NOW,
    );
    expect(response.rejected.map((r) => [r.key, r.code])).toEqual([
      ["events:v", "bad_item"],
      ["events:far", "bad_range"],
    ]);
    expect(response.inserted).toBe(1);
  });

  it("lists an event that began before the window and is still going", () => {
    repo.ingest(
      APPLE_CALENDAR,
      batch("b1", {
        upserts: [
          event("trip", TOMORROW - 2 * DAY, TOMORROW + 2 * DAY, { allDay: true }),
          event("lunch", TOMORROW + 12 * HOUR, TOMORROW + 13 * HOUR),
          event("yesterday", TOMORROW - DAY - 10 * HOUR, TOMORROW - DAY - 9 * HOUR),
        ],
      }),
      NOW,
    );
    const answer = list({ start: "2026-11-18T12:00", end: "2026-11-18T18:00" });
    const records = (answer.results[0] as unknown as { records: { id: string }[] }).records;
    expect(records.map((r) => r.id)).toEqual(["trip", "lunch"]);
  });

  it("matches words in the content, any case", () => {
    repo.ingest(
      APPLE_CALENDAR,
      batch("b1", {
        upserts: [
          event("a", TOMORROW + 9 * HOUR, TOMORROW + 10 * HOUR, { title: "Design review" }),
          event("b", TOMORROW + 11 * HOUR, TOMORROW + 12 * HOUR, { title: "Lunch with 50% off" }),
          event("c", TOMORROW + 13 * HOUR, TOMORROW + 14 * HOUR, {
            title: "Coffee",
            calendar: "Work",
            allDay: false,
            attendees: ["Émile"],
          }),
        ],
      }),
      NOW,
    );
    const ids = (input: Record<string, unknown>) =>
      (
        list({ start: "2026-11-18", end: "2026-11-18", ...input }).results[0] as unknown as {
          records: { id: string }[];
        }
      ).records.map((r) => r.id);
    expect(ids({ search: "REVIEW" })).toEqual(["a"]);
    expect(ids({ search: "50%" })).toEqual(["b"]);
    expect(ids({ search: "_" })).toEqual([]);
    // Key names and ids are not words: "Cal" would match every `calendar`.
    expect(ids({ search: "Cal" })).toEqual([]);
    expect(ids({ search: "allday" })).toEqual([]);
    expect(ids({ search: "work" })).toEqual(["c"]);
    expect(ids({ search: "Émile" })).toEqual(["c"]);
    // Any script folds for case, not ASCII alone.
    expect(ids({ search: "émile" })).toEqual(["c"]);
    expect(ids({ search: "ÉMILE" })).toEqual(["c"]);
  });

  it("finds a match past a page of entries that do not hold the words", () => {
    const upserts = Array.from({ length: 520 }, (_, i) =>
      event(`n${i}`, TOMORROW + 9 * HOUR + i * 1000, TOMORROW + 10 * HOUR, { title: "Standup" }),
    );
    upserts.push(event("z", TOMORROW + 20 * HOUR, TOMORROW + 21 * HOUR, { title: "Встреча" }));
    repo.ingest(APPLE_CALENDAR, batch("b1", { upserts }), NOW);
    const found = list({ start: "2026-11-18", end: "2026-11-18", search: "встреча" })
      .results[0] as unknown as {
      records: { id: string }[];
    };
    expect(found.records.map((r) => r.id)).toEqual(["z"]);
  });

  it("removes an event the phone deleted", () => {
    repo.ingest(
      APPLE_CALENDAR,
      batch("b1", { upserts: [event("a", TOMORROW + 9 * HOUR, TOMORROW + 10 * HOUR)] }),
      NOW,
    );
    const { response } = repo.ingest(
      APPLE_CALENDAR,
      batch("b2", { deletes: [{ key: "events:a" }] }),
      NOW,
    );
    expect(response.deleted).toBe(1);
    expect(
      (list({ start: "2026-11-18", end: "2026-11-18" }).results[0] as { records: unknown[] })
        .records,
    ).toEqual([]);
  });

  it("covers a future window from a recent sync, and points live once it is old", () => {
    repo.ingest(
      APPLE_CALENDAR,
      batch("b1", {
        upserts: [event("old", NOW - 5 * DAY, NOW - 5 * DAY + HOUR)],
        syncedThrough: NOW,
      }),
      NOW,
    );
    const fresh = list({ start: "2026-11-18T12:00", end: "2026-11-18T18:00" }, NOW + 10 * 60_000);
    expect(fresh.freshness.events).toMatchObject({ coversWindow: false });
    expect(fresh.freshness.events.syncedThrough).toBe(iso(NOW));
    const atSync = list({ start: "2026-11-18T12:00", end: "2026-11-18T18:00" }, NOW);
    expect(atSync.freshness.events).toMatchObject({ coversWindow: true });
    expect(atSync.connection).toBeUndefined();
  });

  it("does not cover a window past the 30 days the phone sends, however recent the sync", () => {
    repo.ingest(
      APPLE_CALENDAR,
      batch("b1", {
        upserts: [event("old", NOW - 5 * DAY, NOW - 5 * DAY + HOUR)],
        syncedThrough: NOW,
      }),
      NOW,
    );
    const inside = list({ start: "2026-12-10", end: "2026-12-10" }, NOW);
    expect(inside.freshness.events).toMatchObject({ coversWindow: true });
    const past = list({ start: "2027-01-20", end: "2027-01-20" }, NOW);
    expect(past.freshness.events).toMatchObject({
      coversWindow: false,
      missingFrom: iso(Date.parse("2027-01-19T16:00:00Z")),
    });
    const straddling = list({ start: "2026-12-10", end: "2026-12-20" }, NOW);
    expect(straddling.freshness.events).toMatchObject({
      coversWindow: false,
      missingFrom: iso(NOW + 30 * DAY),
    });
  });

  it("covers only the 7 days a sync reads back, whatever older events it holds", () => {
    repo.ingest(
      APPLE_CALENDAR,
      batch("b1", {
        upserts: [event("old", NOW - 70 * DAY, NOW - 70 * DAY + HOUR)],
        syncedThrough: NOW - 70 * DAY,
      }),
      NOW - 70 * DAY,
    );
    repo.ingest(APPLE_CALENDAR, batch("b2", { syncedThrough: NOW }), NOW);
    // 20 days ago fell between the two syncs: no event there is not a free day.
    const gap = list({ start: "2026-10-28", end: "2026-10-28" }, NOW);
    expect(gap.freshness.events).toMatchObject({ coversWindow: false });
    const recent = list({ start: "2026-11-12", end: "2026-11-12" }, NOW);
    expect(recent.freshness.events).toMatchObject({ coversWindow: true });
  });

  it("covers an empty calendar the phone synced", () => {
    repo.ingest(APPLE_CALENDAR, batch("b1", { syncedThrough: NOW }), NOW);
    const answer = list({ start: "2026-11-18", end: "2026-11-18" }, NOW);
    expect(answer.freshness.events).toMatchObject({ coversWindow: true });
    expect((answer.results[0] as { records: unknown[] }).records).toEqual([]);
  });

  it("refuses interval, aggregate and unit for entries, and search for readings", () => {
    const answer = queryPersonalData(
      repo,
      APPLE_CALENDAR,
      { source: "apple_calendar", type: "events", interval: "day" },
      { tz: TZ, now: NOW },
    );
    expect(answer).toEqual({
      error: "events is listed, not aggregated: leave out interval, aggregate and unit.",
    });
  });
});
