import { describe, it, expect, beforeEach, afterEach } from "@rstest/core";
import { createTestDb, type TestDb } from "../../../../../packages/core/src/test/helpers.js";
import { RoutinesRepository } from "../../../../../packages/core/src/db/repositories/routines.js";
import type { ScheduleTrigger } from "../../../../../packages/core/src/routines/types.js";

import { searchRoutine } from "./index.js";

let testDb: TestDb;

function repo(): RoutinesRepository {
  return new RoutinesRepository(testDb.db);
}

function schedule(localTime: string): ScheduleTrigger {
  return {
    type: "schedule",
    tzid: "America/Los_Angeles",
    tzMode: "fixed",
    localTime,
    rrule: "FREQ=DAILY",
  };
}

/** Seed a fixed fixture of four routines spanning distinct names, actions,
 * args and times — enough to exercise ranking and disambiguation. */
async function seed(): Promise<void> {
  const r = repo();
  await r.create({
    name: "water reminder",
    trigger: schedule("08:00"),
    actionName: "send_message",
    args: { text: "time to drink water" },
  });
  await r.create({
    name: "water plants",
    trigger: schedule("18:45"),
    actionName: "send_message",
    args: { text: "water the plants" },
  });
  await r.create({
    name: "evening journal",
    trigger: schedule("21:30"),
    actionName: "journal",
    args: {},
  });
  await r.create({
    name: "morning standup",
    trigger: schedule("09:15"),
    actionName: "daily_standup",
    args: { channel: "general" },
  });
}

describe("searchRoutine", () => {
  beforeEach(async () => {
    testDb = createTestDb();
    await seed();
  });

  afterEach(() => {
    testDb.close();
  });

  it("surfaces the described routine as the top match and excludes unrelated ones", async () => {
    const { matches } = await searchRoutine({ query: "drink water" }, { routinesRepo: repo() });

    expect(matches[0].name).toBe("water reminder");
    const names = matches.map((m) => m.name);
    expect(names).not.toContain("evening journal");
    expect(names).not.toContain("morning standup");
  });

  it("returns multiple matches when the description is ambiguous, best first", async () => {
    // "water" hits both water routines; only "water reminder" also carries
    // "drink", so it must rank ahead — but both come back for the agent to
    // disambiguate with the user.
    const { matches } = await searchRoutine({ query: "drink water" }, { routinesRepo: repo() });

    const names = matches.map((m) => m.name);
    expect(names).toContain("water reminder");
    expect(names).toContain("water plants");
    expect(names.indexOf("water reminder")).toBeLessThan(names.indexOf("water plants"));
  });

  it("does not filter on the schedule — a time-only query matches nothing", async () => {
    // Time filtering is deferred to the agent (see "describes each match's
    // schedule"); a bare time string is not matched against routines.
    const { matches } = await searchRoutine({ query: "09:15" }, { routinesRepo: repo() });
    expect(matches).toHaveLength(0);
  });

  it("returns each match's schedule in human terms for the agent to filter by time", async () => {
    const { matches } = await searchRoutine({ query: "water reminder" }, { routinesRepo: repo() });
    expect(matches[0].schedule).toContain("08:00");
    expect(matches[0].schedule).toContain("FREQ=DAILY");
  });

  it("returns no matches when nothing fits the description", async () => {
    const result = await searchRoutine({ query: "deploy kubernetes" }, { routinesRepo: repo() });
    expect(result.matches).toHaveLength(0);
    expect(result.totalRoutines).toBe(4);
  });

  it("lists every routine for an empty query", async () => {
    const { matches, totalRoutines } = await searchRoutine({ query: "" }, { routinesRepo: repo() });
    expect(matches).toHaveLength(4);
    expect(totalRoutines).toBe(4);
  });

  it("ignores common stopwords so a chatty description still finds the routine", async () => {
    // "stop reminding me to drink water in the morning" — only "drink"/"water"
    // carry intent; the stopwords must not drag in unrelated routines.
    const { matches } = await searchRoutine(
      { query: "stop reminding me to drink water in the morning" },
      { routinesRepo: repo() },
    );
    expect(matches[0].name).toBe("water reminder");
  });
});
