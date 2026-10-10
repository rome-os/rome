import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { describe, expect, it } from "@rstest/core";

const MIGRATION = readFileSync(
  resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../drizzle/system/0072_date_undated_one_off_routines.sql",
  ),
  "utf8",
);

function utcDate(at: Date, offsetDays: number): string {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate() + offsetDays))
    .toISOString()
    .slice(0, 10);
}

/** What the migration should pick for `localTime` if it ran at `at`. */
function expectedDate(at: Date, localTime: string, extraDays = 0): string {
  const today = localTime > at.toISOString().slice(11, 16) ? 0 : 1;
  return utcDate(at, today + extraDays);
}

function createTables(sqlite: Database.Database): void {
  sqlite.exec(
    "CREATE TABLE routines (id text PRIMARY KEY NOT NULL, `trigger` text NOT NULL, last_fired_at integer, enabled integer DEFAULT 1)",
  );
  sqlite.exec("CREATE TABLE settings (`key` text PRIMARY KEY NOT NULL, `value` text NOT NULL)");
}

describe("undated one-off routine migration", () => {
  it("dates every schedule that has neither date nor rrule, and nothing else", () => {
    const sqlite = new Database(":memory:");
    createTables(sqlite);
    const insert = sqlite.prepare(
      "INSERT INTO routines (id, `trigger`, last_fired_at) VALUES (?, ?, ?)",
    );
    const schedule = { type: "schedule", tzid: "UTC", tzMode: "floating" };
    // 2026-06-23T12:00:00Z
    insert.run("fired", JSON.stringify({ ...schedule, localTime: "12:00" }), 1_782_216_000);
    sqlite.exec("UPDATE routines SET enabled = 0 WHERE id = 'fired'");
    // Fired, then switched back on: still pending, so it gets the next date.
    insert.run("refired", JSON.stringify({ ...schedule, localTime: "23:59" }), 1_782_216_000);
    insert.run("pending-late", JSON.stringify({ ...schedule, localTime: "23:59" }), null);
    insert.run("pending-early", JSON.stringify({ ...schedule, localTime: "0:00" }), null);
    const tokyo = { ...schedule, tzid: "Asia/Tokyo", localTime: "23:59" };
    insert.run("pending-tokyo", JSON.stringify(tokyo), null);
    insert.run("blank-rrule", JSON.stringify({ ...schedule, localTime: "23:59", rrule: "" }), null);
    const recurring = JSON.stringify({ ...schedule, localTime: "09:00", rrule: "FREQ=DAILY" });
    const dated = JSON.stringify({ ...schedule, localTime: "09:00", date: "2099-01-01" });
    const manual = JSON.stringify({ type: "manual" });
    insert.run("recurring", recurring, null);
    insert.run("dated", dated, null);
    insert.run("manual", manual, null);

    // SQLite reads its own clock, so accept the answer for either side of the run.
    const before = new Date();
    sqlite.exec(MIGRATION);
    const after = new Date();
    const pendingDate = (localTime: string, extraDays = 0) => [
      expectedDate(before, localTime, extraDays),
      expectedDate(after, localTime, extraDays),
    ];

    const triggers = Object.fromEntries(
      (
        sqlite.prepare("SELECT id, `trigger` FROM routines").all() as {
          id: string;
          trigger: string;
        }[]
      ).map((row) => [row.id, row.trigger]),
    );
    const parsed = (id: string) => JSON.parse(triggers[id]) as Record<string, unknown>;
    expect(parsed("fired")).toMatchObject({ date: "2026-06-23", tzMode: "fixed" });
    expect(pendingDate("23:59")).toContain(parsed("pending-late").date);
    expect(pendingDate("00:00")).toContain(parsed("pending-early").date);
    expect(parsed("pending-early").tzMode).toBe("fixed");
    // A non-UTC zone takes the day after, so the date is never already past there.
    expect(pendingDate("23:59", 1)).toContain(parsed("pending-tokyo").date);
    expect(parsed("refired").date).toBe(parsed("pending-late").date);
    expect(parsed("blank-rrule").date).toBe(parsed("pending-late").date);
    expect(parsed("blank-rrule")).not.toHaveProperty("rrule");
    expect(triggers.recurring).toBe(recurring);
    expect(triggers.dated).toBe(dated);
    expect(triggers.manual).toBe(manual);
  });

  it("moves a floating row to the guardian's zone before dating it", () => {
    const sqlite = new Database(":memory:");
    createTables(sqlite);
    sqlite.exec(`INSERT INTO settings VALUES ('guardianTimezone', '"Asia/Tokyo"')`);
    const insert = sqlite.prepare("INSERT INTO routines (id, `trigger`) VALUES (?, ?)");
    const pending = { type: "schedule", tzid: "UTC", localTime: "23:59" };
    insert.run("floating", JSON.stringify({ ...pending, tzMode: "floating" }));
    insert.run("fixed", JSON.stringify({ ...pending, tzMode: "fixed" }));

    sqlite.exec(MIGRATION);

    const trigger = (id: string) =>
      JSON.parse(
        (
          sqlite.prepare("SELECT `trigger` FROM routines WHERE id = ?").get(id) as {
            trigger: string;
          }
        ).trigger,
      ) as Record<string, unknown>;
    expect(trigger("floating")).toMatchObject({ tzid: "Asia/Tokyo", tzMode: "fixed" });
    expect(trigger("fixed").tzid).toBe("UTC");
    // Now outside UTC, the floating row takes the later, never-past date.
    expect(trigger("floating").date).not.toBe(trigger("fixed").date);
  });
});
