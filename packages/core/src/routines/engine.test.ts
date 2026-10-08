import { describe, it, expect, beforeEach, afterEach, rs } from "@rstest/core";
import { RoutineEngine } from "./engine.js";
import { createTestDb, type TestDb } from "../test/helpers.js";
import { RoutinesRepository } from "../db/repositories/routines.js";
import { RoutineRunsRepository } from "../db/repositories/routine-runs.js";
import type { ActionEngine } from "../actions/engine.js";
import { systemClock, type Clock } from "../lib/clock.js";
import type { TriggerProvider } from "./trigger-provider.js";
import type { Trigger } from "./types.js";

// reactivateFloating only touches routinesRepo + activate(); the other ctor
// deps are never reached, so stub them rather than stand up the whole engine.
function makeEngine(repo: RoutinesRepository): RoutineEngine {
  return new RoutineEngine(
    repo,
    {} as unknown as RoutineRunsRepository,
    {} as unknown as ActionEngine,
    0,
    {} as unknown as Clock,
  );
}

describe("RoutineEngine.reactivateFloating", () => {
  let testDb: TestDb;
  let repo: RoutinesRepository;

  beforeEach(() => {
    testDb = createTestDb();
    repo = new RoutinesRepository(testDb.db);
  });

  afterEach(() => testDb.close());

  async function seed(name: string, trigger: Trigger, enabled = true): Promise<string> {
    return repo.create({ name, trigger, actionName: "noop", args: {}, enabled });
  }

  it("re-activates every non-fixed enabled schedule, leaving fixed/disabled/other alone", async () => {
    const floatingId = await seed("floating", {
      type: "schedule",
      tzid: "UTC",
      tzMode: "floating",
      localTime: "09:00",
      rrule: "FREQ=DAILY",
    });
    // A legacy row that lacks tzMode (cast past the now-required field) reads as
    // floating, so it follows the guardian and must be re-activated too.
    const unsetId = await seed("legacy", {
      type: "schedule",
      tzid: "UTC",
      localTime: "09:00",
      rrule: "FREQ=DAILY",
    } as unknown as Trigger);
    // Explicit fixed (absolute zone): the one schedule kind left untouched.
    await seed("fixed", {
      type: "schedule",
      tzid: "Asia/Tokyo",
      tzMode: "fixed",
      localTime: "09:00",
      rrule: "FREQ=DAILY",
    });
    // Disabled floating: not live, so not re-activated by this sweep.
    await seed(
      "disabled-floating",
      {
        type: "schedule",
        tzid: "UTC",
        tzMode: "floating",
        localTime: "09:00",
        rrule: "FREQ=DAILY",
      },
      false,
    );
    // Non-schedule trigger: irrelevant to timezone.
    await seed("eventbus", { type: "event-bus", eventName: "x.y" });

    const engine = makeEngine(repo);
    const activate = rs.spyOn(engine, "activate").mockResolvedValue();

    await engine.reactivateFloating();

    expect(activate).toHaveBeenCalledTimes(2);
    const reactivatedIds = activate.mock.calls.map((c) => c[0].id).sort();
    expect(reactivatedIds).toEqual([floatingId, unsetId].sort());
  });

  it("is a no-op when every schedule is explicitly fixed", async () => {
    await seed("fixed", {
      type: "schedule",
      tzid: "UTC",
      tzMode: "fixed",
      localTime: "09:00",
      rrule: "FREQ=DAILY",
    });
    const engine = makeEngine(repo);
    const activate = rs.spyOn(engine, "activate").mockResolvedValue();

    await engine.reactivateFloating();

    expect(activate).not.toHaveBeenCalled();
  });
});

describe("RoutineEngine run records", () => {
  let testDb: TestDb;

  beforeEach(() => {
    testDb = createTestDb();
  });

  afterEach(() => testDb.close());

  it("records what fired each run: the trigger type, or run_now for a manual run", async () => {
    const routines = new RoutinesRepository(testDb.db);
    const runs = new RoutineRunsRepository(testDb.db);
    const actionEngine = {
      run: async () => ({ status: "success", result: null }),
    } as unknown as ActionEngine;
    const engine = new RoutineEngine(routines, runs, actionEngine, 0, systemClock);
    let fire: ((payload: Record<string, unknown>) => Promise<void>) | undefined;
    const provider: Pick<TriggerProvider, "activate" | "deactivate"> = {
      activate: async (_routine, onFire) => {
        fire = onFire;
      },
      deactivate: () => {},
    };
    engine.registerProvider("schedule", provider as TriggerProvider);
    const id = await routines.create({
      name: "digest",
      trigger: { type: "schedule", tzid: "UTC", tzMode: "fixed", localTime: "09:00" },
      actionName: "noop",
      args: {},
    });
    await engine.start();

    await fire?.({});
    await engine.runNow(id);

    const recorded = await runs.findByRoutineId(id);
    const firedBy = await Promise.all(recorded.map((run) => runs.findFiredBy(run.executionId)));
    expect(firedBy.sort()).toEqual(["run_now", "schedule"]);
  });
});

describe("RoutineEngine worker admission", () => {
  let testDb: TestDb;

  beforeEach(() => {
    testDb = createTestDb();
  });

  afterEach(() => testDb.close());

  it("queues its action for a worker instead of failing on a busy pool", async () => {
    const routines = new RoutinesRepository(testDb.db);
    const runs = new RoutineRunsRepository(testDb.db);
    const run = rs.fn(async () => ({ status: "success", result: null }));
    const engine = new RoutineEngine(
      routines,
      runs,
      { run } as unknown as ActionEngine,
      0,
      systemClock,
    );
    const id = await routines.create({
      name: "digest",
      trigger: { type: "manual" },
      actionName: "noop",
      args: {},
    });

    await engine.runNow(id);

    expect(run).toHaveBeenCalledWith(
      "noop",
      expect.anything(),
      expect.objectContaining({ whenWorkersBusy: "queue" }),
    );
  });
});
