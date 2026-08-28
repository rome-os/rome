import { describe, it, expect, beforeEach, afterEach } from "@rstest/core";
import { v4 as uuid } from "uuid";
import { createTestDb, type TestDb } from "../test/helpers.js";
import { events } from "../db/schema.js";
import { RoutinesRepository } from "../db/repositories/routines.js";
import { SettingsRepository } from "../db/repositories/settings.js";
import { migrateEventsToRoutines, EVENTS_MIGRATED_FLAG } from "./migrate-events-to-routines.js";
import { parseDateAndLocalTime } from "./schedule-trigger-provider.js";
import type { ScheduleTrigger } from "./types.js";

const NOW = new Date("2026-05-29T12:00:00Z");

interface EventSeed {
  name?: string;
  type: "one-off" | "recurring";
  tzid?: string;
  localTime?: string;
  rrule?: string | null;
  startTime?: Date;
  actionName?: string;
  args?: unknown;
  enabled?: boolean;
}

describe("migrateEventsToRoutines", () => {
  let testDb: TestDb;
  let routinesRepo: RoutinesRepository;
  let settingsRepo: SettingsRepository;

  beforeEach(() => {
    testDb = createTestDb();
    routinesRepo = new RoutinesRepository(testDb.db);
    settingsRepo = new SettingsRepository(testDb.db);
  });

  afterEach(() => {
    testDb.close();
  });

  async function seedEvent(seed: EventSeed): Promise<string> {
    const id = uuid();
    await testDb.db.insert(events).values({
      id,
      name: seed.name ?? "evt",
      type: seed.type,
      tzid: seed.tzid ?? "UTC",
      localTime: seed.localTime ?? "09:00",
      rrule: seed.rrule ?? null,
      startTime: seed.startTime ?? new Date("2099-01-01T09:00:00Z"),
      endTime: null,
      actionName: seed.actionName ?? "do_thing",
      args: (seed.args ?? [{}]) as unknown,
      enabled: seed.enabled ?? true,
      createdAt: new Date("2026-01-01T00:00:00Z"),
      lastRunAt: null,
      nextRunAt: null,
    });
    return id;
  }

  function run() {
    return migrateEventsToRoutines({
      db: testDb.db,
      routinesRepo,
      settingsRepo,
      now: NOW,
    });
  }

  it("migrates a recurring event into an enabled schedule routine that preserves the rrule", async () => {
    await seedEvent({
      name: "daily digest",
      type: "recurring",
      tzid: "America/New_York",
      localTime: "08:30",
      rrule: "FREQ=WEEKLY;BYDAY=MO",
      actionName: "send_digest",
      args: [{ topic: "news" }],
    });

    const result = await run();
    expect(result.routinesCreated).toBe(1);

    const [routine] = await routinesRepo.findAll();
    expect(routine.name).toBe("daily digest");
    expect(routine.enabled).toBe(true);
    expect(routine.actionName).toBe("send_digest");
    expect(routine.args).toEqual({ topic: "news" });
    expect(routine.trigger).toEqual({
      type: "schedule",
      tzid: "America/New_York",
      // Migrated legacy events keep their stored zone as an absolute pin.
      tzMode: "fixed",
      localTime: "08:30",
      rrule: "FREQ=WEEKLY;BYDAY=MO",
    });
  });

  it("synthesizes FREQ=DAILY for a recurring event with no rrule so it stays recurring", async () => {
    await seedEvent({ type: "recurring", rrule: null, localTime: "07:15" });

    await run();

    const [routine] = await routinesRepo.findAll();
    const trigger = routine.trigger as ScheduleTrigger;
    // An empty rrule would make the schedule provider treat the routine as a
    // one-off; FREQ=DAILY keeps it firing every day at localTime.
    expect(trigger.rrule).toBe("FREQ=DAILY");
    expect(trigger.date).toBeUndefined();
  });

  it("migrates a future one-off to a dated trigger that fires at the original startTime instant", async () => {
    // 02:30 UTC on 2099-06-15 is 2099-06-14 19:30 in LA (PDT, UTC-7).
    const startTime = new Date("2099-06-15T02:30:00Z");
    await seedEvent({
      type: "one-off",
      tzid: "America/Los_Angeles",
      localTime: "00:00", // deliberately wrong vs. startTime — must be ignored
      startTime,
      actionName: "one_shot",
      args: [{ k: "v" }],
    });

    const result = await run();
    expect(result.routinesCreated).toBe(1);
    expect(result.skippedPastOneOff).toBe(0);

    const [routine] = await routinesRepo.findAll();
    const trigger = routine.trigger as ScheduleTrigger;
    expect(trigger.date).toBe("2099-06-14");
    expect(trigger.localTime).toBe("19:30");
    expect(trigger.rrule).toBeUndefined();
    // The real contract: feeding the trigger back through the provider's date
    // parser reproduces the original fire instant.
    expect(parseDateAndLocalTime(trigger.date!, trigger.localTime, trigger.tzid).getTime()).toBe(
      startTime.getTime(),
    );
  });

  it("skips a past-dated one-off because it would never fire", async () => {
    await seedEvent({
      type: "one-off",
      startTime: new Date("2020-01-01T09:00:00Z"),
    });

    const result = await run();

    expect(result.skippedPastOneOff).toBe(1);
    expect(result.routinesCreated).toBe(0);
    expect(await routinesRepo.findAll()).toHaveLength(0);
  });

  it("fans out an array of >1 args into one numbered routine per element", async () => {
    await seedEvent({
      name: "broadcast",
      type: "recurring",
      rrule: "FREQ=DAILY",
      actionName: "notify",
      args: [{ to: "a" }, { to: "b" }, { to: "c" }],
    });

    const result = await run();
    expect(result.routinesCreated).toBe(3);

    const routines = (await routinesRepo.findAll()).sort((x, y) => x.name.localeCompare(y.name));
    expect(routines.map((r) => r.name)).toEqual(["broadcast #1", "broadcast #2", "broadcast #3"]);
    expect(routines.map((r) => r.args)).toEqual([{ to: "a" }, { to: "b" }, { to: "c" }]);
  });

  it("keeps the original name for a single-element arg array", async () => {
    await seedEvent({ name: "solo", type: "recurring", args: [{ x: 1 }] });

    await run();

    const [routine] = await routinesRepo.findAll();
    expect(routine.name).toBe("solo");
    expect(routine.args).toEqual({ x: 1 });
  });

  it("creates a single routine with empty args for an empty arg array", async () => {
    await seedEvent({ name: "no-args", type: "recurring", args: [] });

    const result = await run();

    expect(result.routinesCreated).toBe(1);
    const [routine] = await routinesRepo.findAll();
    expect(routine.args).toEqual({});
  });

  it("does not migrate disabled events", async () => {
    await seedEvent({ type: "recurring", enabled: false });

    const result = await run();

    expect(result.eventsRead).toBe(0);
    expect(await routinesRepo.findAll()).toHaveLength(0);
  });

  it("skips a row whose args fail schema validation but migrates the valid rows", async () => {
    // A primitive-element args array can only reach the table via the old
    // unvalidated POST /api/events route. Parsing at the read boundary catches
    // it loudly instead of silently coercing it to {} args.
    await seedEvent({ name: "bad", type: "recurring", args: ["topic", "sports"] });
    await seedEvent({
      name: "good",
      type: "recurring",
      rrule: "FREQ=DAILY",
      args: [{ ok: true }],
    });

    const result = await run();

    expect(result.skippedInvalid).toBe(1);
    expect(result.routinesCreated).toBe(1);
    const routines = await routinesRepo.findAll();
    expect(routines).toHaveLength(1);
    expect(routines[0].name).toBe("good");
  });

  it("is idempotent: a second run creates nothing and reports alreadyMigrated", async () => {
    await seedEvent({ type: "recurring", rrule: "FREQ=DAILY" });

    const first = await run();
    expect(first.alreadyMigrated).toBe(false);
    expect(first.routinesCreated).toBe(1);
    expect(await settingsRepo.get<boolean>(EVENTS_MIGRATED_FLAG)).toBe(true);

    const second = await run();
    expect(second.alreadyMigrated).toBe(true);
    expect(second.routinesCreated).toBe(0);
    expect(await routinesRepo.findAll()).toHaveLength(1);
  });
});
