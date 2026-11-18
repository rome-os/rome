// Snapshots: a device sends every calendar event in a window, batch by batch,
// and the last batch commits, which deletes what the window held that the
// snapshot did not send. Invented events, no real person's data.

import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { createTestDb, type TestDb } from "../test/db.js";
import { personalDataPoints, personalDataTypes } from "../db/schema/system.js";
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
/** The window a phone reads at NOW: 7 days before today's midnight to 30 days ahead. */
const START = Date.parse("2026-11-09T16:00:00Z");
const END = NOW + 30 * DAY;
const iso = (at: number) => new Date(at).toISOString();

const PHONE = "origin-calendar-phone";
const OLD_PHONE = "origin-calendar-old-phone";

interface Snapshot {
  id: string;
  readAt?: number;
  window?: { start: number; end: number };
}

function batch(
  id: string,
  items: {
    upserts?: unknown[];
    deletes?: unknown[];
    syncedThrough?: number;
    snapshot?: Snapshot;
    origin?: string;
  } = {},
): IngestEnvelope {
  const snapshot = items.snapshot;
  return {
    version: 1,
    source: "apple_calendar",
    origin: { id: items.origin ?? PHONE, name: "iPhone", platform: "ios" },
    batch: { id, trigger: "foreground" },
    types:
      items.syncedThrough === undefined
        ? []
        : [{ type: "events", syncedThrough: iso(items.syncedThrough) }],
    ...(snapshot
      ? {
          snapshot: {
            id: snapshot.id,
            readAt: iso(snapshot.readAt ?? NOW),
            ...(snapshot.window
              ? {
                  windows: [
                    {
                      type: "events",
                      start: iso(snapshot.window.start),
                      end: iso(snapshot.window.end),
                    },
                  ],
                }
              : {}),
          },
        }
      : {}),
    upserts: items.upserts ?? [],
    deletes: items.deletes ?? [],
  };
}

function event(id: string, start: number, end: number) {
  return {
    key: `events:${id}`,
    type: "events",
    shape: "entry",
    start: iso(start),
    end: iso(end),
    tz: TZ,
    content: { id, title: `Event ${id}`, availability: "busy" },
  };
}

const WINDOW = { start: START, end: END };

describe("snapshots", () => {
  let testDb: TestDb;
  let repo: PersonalDataRepository;

  beforeEach(() => {
    testDb = createTestDb();
    repo = new PersonalDataRepository(testDb.db, PERSONAL_DATA_SOURCES);
  });
  afterEach(() => testDb.close());

  const ingest = (envelope: IngestEnvelope, at = NOW) =>
    repo.ingest(APPLE_CALENDAR, envelope, at).response;
  const keys = (origin = PHONE) =>
    testDb.db
      .select()
      .from(personalDataPoints)
      .all()
      .filter((row) => row.origin === origin)
      .map((row) => row.dedupeKey)
      .sort();
  const list = (start: string, end: string, now = NOW) => {
    const answer = queryPersonalData(
      repo,
      APPLE_CALENDAR,
      { source: "apple_calendar", type: "events", start, end },
      { tz: TZ, now },
    );
    if ("error" in answer) throw new Error(answer.error);
    return answer;
  };
  const records = (answer: ReturnType<typeof list>) =>
    (answer.results[0] as { records: { id?: string }[] }).records;

  it("keeps a batch with no snapshot as it was: deletes by key, coverage by the type's span", () => {
    ingest(batch("b1", { upserts: [event("a", TOMORROW, TOMORROW + HOUR)] }));
    const answer = ingest(
      batch("b2", {
        upserts: [event("b", TOMORROW + 2 * HOUR, TOMORROW + 3 * HOUR)],
        deletes: [{ key: "events:a" }],
        syncedThrough: NOW,
      }),
    );
    expect(answer).toMatchObject({ inserted: 1, deleted: 1 });
    expect(answer.committed).toBeUndefined();
    expect(keys()).toEqual(["events:b"]);
    const stored = testDb.db.select().from(personalDataPoints).all();
    expect(stored.every((row) => row.snapshotId === null)).toBe(true);
    const type = testDb.db.select().from(personalDataTypes).all()[0];
    expect(type).toMatchObject({ snapshotId: null, snapshotStartAt: null, snapshotEndAt: null });
    // Coverage still reads the 30 days the type declares past the sync.
    expect(list("2026-12-10", "2026-12-20").freshness.events).toMatchObject({
      coversWindow: false,
      missingFrom: iso(NOW + 30 * DAY),
    });
  });

  it("deletes what the window held that the snapshot did not send, and keeps the rest", () => {
    ingest(
      batch("b1", {
        upserts: [
          event("kept", TOMORROW, TOMORROW + HOUR),
          event("gone", TOMORROW + 2 * HOUR, TOMORROW + 3 * HOUR),
          // Aged out before the window: history, which no snapshot touches.
          event("history", START - 3 * DAY, START - 3 * DAY + HOUR),
        ],
      }),
    );
    ingest(batch("other", { origin: OLD_PHONE, upserts: [event("x", TOMORROW, TOMORROW + HOUR)] }));
    const answer = ingest(
      batch("s1", {
        upserts: [event("kept", TOMORROW, TOMORROW + HOUR)],
        snapshot: { id: "snap-1", window: WINDOW },
        syncedThrough: NOW,
      }),
    );
    expect(answer).toMatchObject({ unchanged: 1, deleted: 1, committed: ["events"] });
    expect(keys()).toEqual(["events:history", "events:kept"]);
    expect(keys(OLD_PHONE)).toEqual(["events:x"]);
  });

  it("commits once: a retried commit is a success that changes nothing", () => {
    ingest(
      batch("s1", {
        upserts: [event("a", TOMORROW, TOMORROW + HOUR)],
        snapshot: { id: "snap-1", window: WINDOW },
      }),
    );
    // The answer was lost; the commit goes again in a new batch, and another
    // event has since been added through a delta from an older build.
    ingest(batch("d1", { upserts: [event("b", TOMORROW + 2 * HOUR, TOMORROW + 3 * HOUR)] }));
    const again = ingest(
      batch("s1-retry", {
        upserts: [event("a", TOMORROW, TOMORROW + HOUR)],
        snapshot: { id: "snap-1", window: WINDOW },
      }),
      NOW + 1000,
    );
    expect(again).toMatchObject({ status: "ok", deleted: 0, committed: ["events"] });
    expect(keys()).toEqual(["events:a", "events:b"]);
  });

  it("cleans up a snapshot that never committed at the next commit", () => {
    ingest(
      batch("b1", {
        upserts: [
          event("a", TOMORROW, TOMORROW + HOUR),
          event("b", TOMORROW + 2 * HOUR, TOMORROW + 3 * HOUR),
        ],
      }),
    );
    // A run sends its first batch, stamped, and is cut off before the commit.
    ingest(
      batch("cut-1", {
        upserts: [event("c", TOMORROW + 4 * HOUR, TOMORROW + 5 * HOUR)],
        snapshot: { id: "snap-cut" },
      }),
    );
    expect(keys()).toEqual(["events:a", "events:b", "events:c"]);
    // The next run has a and nothing else.
    const answer = ingest(
      batch("s2", {
        upserts: [event("a", TOMORROW, TOMORROW + HOUR)],
        snapshot: { id: "snap-2", readAt: NOW + HOUR, window: WINDOW },
      }),
      NOW + HOUR,
    );
    expect(answer).toMatchObject({ deleted: 2, committed: ["events"] });
    expect(keys()).toEqual(["events:a"]);
  });

  it("never lets an older snapshot replace a newer one", () => {
    ingest(
      batch("s2", {
        upserts: [event("new", TOMORROW, TOMORROW + HOUR)],
        snapshot: { id: "snap-2", readAt: NOW, window: WINDOW },
      }),
    );
    const late = ingest(
      batch("s1", {
        upserts: [event("old", TOMORROW + 2 * HOUR, TOMORROW + 3 * HOUR)],
        snapshot: { id: "snap-1", readAt: NOW - HOUR, window: WINDOW },
      }),
    );
    expect(late.committed).toBeUndefined();
    expect(keys()).toEqual(["events:new", "events:old"]);
  });

  it("deletes only what lies inside the window, and keeps an edge event the snapshot sent", () => {
    ingest(
      batch("b1", {
        upserts: [
          // Overlaps the start: the phone reads and stamps it.
          event("straddles", START - HOUR, START + HOUR),
          // Only touches an edge: never deleted, sent or not.
          event("ends-at-start", START - HOUR, START),
          event("starts-at-end", END, END + HOUR),
        ],
      }),
    );
    const answer = ingest(
      batch("s1", {
        upserts: [event("straddles", START - HOUR, START + HOUR)],
        snapshot: { id: "snap-1", window: WINDOW },
      }),
    );
    expect(answer).toMatchObject({ deleted: 0, committed: ["events"] });
    expect(keys()).toEqual(["events:ends-at-start", "events:starts-at-end", "events:straddles"]);
  });

  it("does not commit a type with a refused item, nor a window past what the type reads", () => {
    ingest(batch("b1", { upserts: [event("a", TOMORROW, TOMORROW + HOUR)] }));
    const refused = ingest(
      batch("s1", {
        upserts: [{ ...event("bad", TOMORROW, TOMORROW + HOUR), end: "not a time" }],
        snapshot: { id: "snap-1", window: WINDOW },
      }),
    );
    expect(refused.committed).toBeUndefined();
    const tooFar = ingest(
      batch("s2", {
        snapshot: { id: "snap-2", window: { start: NOW - 60 * DAY, end: END } },
      }),
    );
    expect(tooFar.committed).toBeUndefined();
    expect(keys()).toEqual(["events:a"]);
  });

  it("covers the window a snapshot read, an empty one too, and nothing past its end", () => {
    ingest(batch("s1", { snapshot: { id: "snap-1", window: WINDOW }, syncedThrough: NOW }));
    const tomorrow = list("2026-11-18", "2026-11-18");
    expect(tomorrow.freshness.events).toMatchObject({ coversWindow: true });
    expect(records(tomorrow)).toEqual([]);
    const later = list("2027-01-15", "2027-01-15");
    expect(later.freshness.events).toMatchObject({ coversWindow: false });
    const straddling = list("2026-12-10", "2026-12-20");
    expect(straddling.freshness.events).toMatchObject({
      coversWindow: false,
      missingFrom: iso(END),
    });
  });

  it("reads a fresh empty snapshot over an older phone's events", () => {
    ingest(
      batch("old", {
        origin: OLD_PHONE,
        upserts: [
          event("history", NOW - 40 * DAY, NOW - 40 * DAY + HOUR),
          event("canceled", TOMORROW, TOMORROW + HOUR),
        ],
        syncedThrough: NOW - HOUR,
      }),
      NOW - HOUR,
    );
    ingest(batch("s1", { snapshot: { id: "snap-1", window: WINDOW }, syncedThrough: NOW }));
    const answer = list("2026-11-18", "2026-11-18");
    expect(records(answer)).toEqual([]);
    expect(answer.freshness.events).toMatchObject({ coversWindow: true });
  });

  it("reads a fresh snapshot whose first event is inside the window over an older phone", () => {
    ingest(
      batch("old", {
        origin: OLD_PHONE,
        upserts: [event("history", NOW - 40 * DAY, NOW - 40 * DAY + HOUR)],
        syncedThrough: NOW - HOUR,
      }),
      NOW - HOUR,
    );
    ingest(
      batch("s1", {
        upserts: [event("meeting", TOMORROW + 10 * HOUR, TOMORROW + 11 * HOUR)],
        snapshot: { id: "snap-1", window: WINDOW },
        syncedThrough: NOW,
      }),
    );
    const answer = list("2026-11-18", "2026-11-18");
    expect(records(answer).map((record) => record.id)).toEqual(["meeting"]);
  });
});
