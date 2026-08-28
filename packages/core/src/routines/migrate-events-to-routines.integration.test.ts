import { describe, it, expect, beforeEach, afterEach } from "@rstest/core";
import { v4 as uuid } from "uuid";
import { createTestDb, type TestDb } from "../test/helpers.js";
import { events } from "../db/schema.js";
import { RoutinesRepository } from "../db/repositories/routines.js";
import { RoutineRunsRepository } from "../db/repositories/routine-runs.js";
import { SettingsRepository } from "../db/repositories/settings.js";
import { RoutineEngine } from "./engine.js";
import { ScheduleTriggerProvider } from "./schedule-trigger-provider.js";
import { migrateEventsToRoutines } from "./migrate-events-to-routines.js";
import { FakeClock } from "../test/kit/index.js";

// End-to-end: seed legacy `events` rows → run the boot migration → start a real
// RoutineEngine + ScheduleTriggerProvider → assert the migrated routine is live
// and, when fired, dispatches the action with the migrated args. This closes
// the gap the row-level test can't: that the trigger shape the migration emits
// is one the engine can actually activate and fire.

/** Reach into the schedule provider's private cron map — `.trigger()` is
 * croner's public "fire now" API, so we drive the routine without wall-clock
 * waits. Mirrors schedule-trigger-provider.test.ts. */
interface FireableJob {
  trigger(): Promise<unknown>;
}
function jobFor(provider: ScheduleTriggerProvider, routineId: string): FireableJob {
  const jobs = (provider as unknown as { jobs: Map<string, FireableJob> }).jobs;
  const job = jobs.get(routineId);
  if (!job) throw new Error(`no cron job for routine ${routineId}`);
  return job;
}

describe("migrateEventsToRoutines → live routine (integration)", () => {
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

  async function seedEvent(seed: {
    name: string;
    type: "one-off" | "recurring";
    tzid: string;
    localTime: string;
    rrule?: string | null;
    startTime?: Date;
    actionName: string;
    args: Record<string, unknown>[];
  }): Promise<void> {
    await testDb.db.insert(events).values({
      id: uuid(),
      name: seed.name,
      type: seed.type,
      tzid: seed.tzid,
      localTime: seed.localTime,
      rrule: seed.rrule ?? null,
      startTime: seed.startTime ?? new Date("2099-01-01T09:00:00Z"),
      endTime: null,
      actionName: seed.actionName,
      args: seed.args as unknown,
      enabled: true,
      createdAt: new Date("2026-01-01T00:00:00Z"),
      lastRunAt: null,
      nextRunAt: null,
    });
  }

  /** Build a real engine whose action dispatches are recorded into `dispatched`
   * — we assert on the observable dispatch, not on collaborator call counts. */
  function buildEngine() {
    const dispatched: Array<{ actionName: string; args: Record<string, unknown> }> = [];
    const actionEngine = {
      run: async (actionName: string, args: Record<string, unknown>) => {
        dispatched.push({ actionName, args });
        return { status: "ok" };
      },
    };
    const provider = new ScheduleTriggerProvider(routinesRepo);
    const engine = new RoutineEngine(
      routinesRepo,
      new RoutineRunsRepository(testDb.db),
      actionEngine as never,
      0,
      new FakeClock(),
    );
    engine.registerProvider("schedule", provider);
    return { engine, provider, dispatched };
  }

  it("a migrated recurring event becomes a live routine that fires its action with the migrated args", async () => {
    await seedEvent({
      name: "digest",
      type: "recurring",
      tzid: "UTC",
      localTime: "09:00",
      rrule: "FREQ=DAILY",
      actionName: "send_digest",
      args: [{ channel: "general" }],
    });

    await migrateEventsToRoutines({
      db: testDb.db,
      routinesRepo,
      settingsRepo,
    });

    const { engine, provider, dispatched } = buildEngine();
    await engine.start();

    const routine = (await routinesRepo.findAll()).find((r) => r.name === "digest");
    expect(routine).toBeDefined();
    expect(routine!.nextRunAt).toBeInstanceOf(Date);
    expect(routine!.nextRunAt!.getTime()).toBeGreaterThan(Date.now());

    await jobFor(provider, routine!.id).trigger();
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].actionName).toBe("send_digest");
    expect(dispatched[0].args.channel).toBe("general");

    engine.stop();
  });

  it("a migrated future one-off fires once and then disables itself", async () => {
    await seedEvent({
      name: "reminder",
      type: "one-off",
      tzid: "UTC",
      localTime: "00:00",
      startTime: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      actionName: "remind",
      args: [{ note: "stand up" }],
    });

    await migrateEventsToRoutines({
      db: testDb.db,
      routinesRepo,
      settingsRepo,
    });

    const { engine, provider, dispatched } = buildEngine();
    await engine.start();

    const routine = (await routinesRepo.findAll()).find((r) => r.name === "reminder");
    expect(routine).toBeDefined();
    expect(routine!.nextRunAt).toBeInstanceOf(Date);

    await jobFor(provider, routine!.id).trigger();
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].actionName).toBe("remind");
    expect(dispatched[0].args.note).toBe("stand up");

    // One-off semantics: consumed after firing.
    const after = await routinesRepo.findById(routine!.id);
    expect(after!.enabled).toBe(false);

    engine.stop();
  });
});
