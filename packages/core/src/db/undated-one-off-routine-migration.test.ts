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

function utcDate(offsetDays: number): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + offsetDays))
    .toISOString()
    .slice(0, 10);
}

describe("undated one-off routine migration", () => {
  it("dates every schedule that has neither date nor rrule, and nothing else", () => {
    const sqlite = new Database(":memory:");
    sqlite.exec(
      "CREATE TABLE routines (id text PRIMARY KEY NOT NULL, `trigger` text NOT NULL, last_fired_at integer)",
    );
    const insert = sqlite.prepare("INSERT INTO routines VALUES (?, ?, ?)");
    const schedule = { type: "schedule", tzid: "UTC", tzMode: "floating" };
    // 2026-06-23T12:00:00Z
    insert.run("fired", JSON.stringify({ ...schedule, localTime: "12:00" }), 1_782_216_000);
    insert.run("pending-late", JSON.stringify({ ...schedule, localTime: "23:59" }), null);
    insert.run("pending-early", JSON.stringify({ ...schedule, localTime: "0:00" }), null);
    insert.run("blank-rrule", JSON.stringify({ ...schedule, localTime: "23:59", rrule: "" }), null);
    const recurring = JSON.stringify({ ...schedule, localTime: "09:00", rrule: "FREQ=DAILY" });
    const dated = JSON.stringify({ ...schedule, localTime: "09:00", date: "2099-01-01" });
    const manual = JSON.stringify({ type: "manual" });
    insert.run("recurring", recurring, null);
    insert.run("dated", dated, null);
    insert.run("manual", manual, null);

    sqlite.exec(MIGRATION);

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
    // 23:59 is still ahead today unless the test runs in that last minute.
    const nowHm = new Date().toISOString().slice(11, 16);
    expect(parsed("pending-late").date).toBe(nowHm < "23:59" ? utcDate(0) : utcDate(1));
    expect(parsed("pending-early")).toMatchObject({ date: utcDate(1), tzMode: "fixed" });
    expect(parsed("blank-rrule").date).toBe(parsed("pending-late").date);
    expect(triggers.recurring).toBe(recurring);
    expect(triggers.dated).toBe(dated);
    expect(triggers.manual).toBe(manual);
  });
});
