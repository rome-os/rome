import { describe, it, expect, beforeEach, afterEach, rs } from "@rstest/core";
import { RoutineEngine } from "./engine.js";
import { createTestDb, type TestDb } from "../test/helpers.js";
import { RoutinesRepository } from "../db/repositories/routines.js";
import type { RoutineRunsRepository } from "../db/repositories/routine-runs.js";
import type { ActionEngine } from "../actions/engine.js";
import type { Clock } from "../lib/clock.js";
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
