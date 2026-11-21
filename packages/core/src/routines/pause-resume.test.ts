import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import type { ActionEngine, ActionRunContext } from "../apps/actions/engine.js";
import { actionExecutionContext } from "../apps/actions/context.js";
import { ActionExecutionsRepository } from "../apps/repositories/action-executions.js";
import { RoutineRunsRepository } from "../db/repositories/routine-runs.js";
import { RoutinesRepository } from "../db/repositories/routines.js";
import { systemClock } from "../lib/clock.js";
import { createTestDb, type TestDb } from "../test/db.js";
import {
  type RoutineOperations,
  type RoutineTurn,
  routineControlService,
  routineOperations,
} from "./control.js";
import { RoutineEngine } from "./engine.js";
import type { Trigger } from "./types.js";

const guardianAsked: RoutineTurn = {
  actor: { kind: "guardian", userId: "guardian", via: "cookie" },
  audience: "private",
};

let testDb: TestDb;
let routines: RoutinesRepository;
let ops: RoutineOperations;
const routineEngine = { activate: rs.fn(async () => {}), deactivate: rs.fn(async () => {}) };

beforeEach(() => {
  testDb = createTestDb();
  // Every routine's chat is the guardian's private chat.
  routines = new RoutinesRepository(testDb.db, async () => "private");
  routineEngine.activate.mockClear();
  routineEngine.deactivate.mockClear();
  ops = routineOperations({
    routines,
    engine: routineEngine as unknown as Parameters<typeof routineOperations>[0]["engine"],
    routineRuns: new RoutineRunsRepository(testDb.db),
    actionExecutions: new ActionExecutionsRepository(testDb.db),
    ownerOfChat: async () => "guardian",
  });
});

afterEach(() => testDb.close());

const daily: Trigger = {
  type: "schedule",
  tzid: "UTC",
  tzMode: "floating",
  localTime: "08:00",
  rrule: "FREQ=DAILY",
};

const createRoutine = (enabled: boolean, trigger: Trigger = daily) =>
  routines.create({ name: "Water reminder", trigger, actionName: "summon", args: {}, enabled });

const pause = (routineId: string, turn: RoutineTurn = guardianAsked) =>
  ops.pause({ routineId }, turn);
const resume = (routineId: string, turn: RoutineTurn = guardianAsked) =>
  ops.resume({ routineId }, turn);

describe("pausing and resuming a routine", () => {
  it("pauses a routine and stops its trigger", async () => {
    const id = await createRoutine(true);

    expect(await pause(id)).toEqual({
      status: "ok",
      data: { routineId: id, name: "Water reminder", enabled: false },
    });
    expect((await routines.findById(id))?.enabled).toBe(false);
    expect(routineEngine.deactivate).toHaveBeenCalledWith(id);
    expect(routineEngine.activate).not.toHaveBeenCalled();
  });

  it("resumes a paused routine and starts its trigger again", async () => {
    const id = await createRoutine(false);

    expect((await resume(id)).status).toBe("ok");
    expect((await routines.findById(id))?.enabled).toBe(true);
    expect(routineEngine.activate).toHaveBeenCalledWith(expect.objectContaining({ id }));
  });

  it("refuses to resume a one-off whose time has passed, as the Routines page does", async () => {
    const id = await createRoutine(false, {
      type: "schedule",
      tzid: "UTC",
      tzMode: "fixed",
      localTime: "08:00",
      date: "2020-01-01",
    });

    const result = await resume(id);

    expect(result).toMatchObject({ status: "error" });
    expect((result as { error: string }).error).toContain("which has passed");
    expect((await routines.findById(id))?.enabled).toBe(false);
  });

  it("names the action to find the right id when the routine does not exist", async () => {
    expect(await pause("nope")).toMatchObject({
      status: "error",
      error: expect.stringContaining("system:search_routine"),
    });
  });

  it("names the field to pass when the id comes under another name", async () => {
    expect(await ops.pause({ id: "a-routine" }, guardianAsked)).toEqual({
      status: "error",
      error: "Pass the routine's id as routineId. Find it with system:search_routine.",
    });
  });
});

describe("who may pause or resume a routine", () => {
  it("refuses a turn the guardian's own message did not start, such as a routine's", async () => {
    const id = await createRoutine(true);
    const result = await pause(id, { audience: "private" });
    expect((result as { error: string }).error).toMatch(/^routine_needs_guardian:/);
    expect((await routines.findById(id))?.enabled).toBe(true);
  });

  it("refuses a routine's fire, though the guardian made the routine in their private chat", async () => {
    // The system action as it runs in the main process: the engine puts the
    // fire's context in the action's store, and the action asks for its turn.
    const engine = {
      run: (_name: string, args: Record<string, unknown>, context: ActionRunContext) =>
        actionExecutionContext.run(
          { ...context, executionId: "fire", rootExecutionId: "fire", initiator: "routine" },
          () => routineControlService(ops).call("pause", args),
        ),
    } as unknown as ActionEngine;
    const target = await createRoutine(true);
    const firing = await actionExecutionContext.run(
      {
        executionId: "e",
        rootExecutionId: "e",
        initiator: "agent:core:main",
        actor: { kind: "guardian", userId: "guardian", via: "cookie" },
      },
      () =>
        routines.create({
          name: "Pause the water reminder",
          trigger: { type: "manual" },
          actionName: "system:pause_routine",
          args: { routineId: target },
          chatId: "guardian-chat",
        }),
    );
    const fires = new RoutineEngine(
      routines,
      new RoutineRunsRepository(testDb.db),
      engine,
      0,
      systemClock,
    );

    const run = await fires.runNow(firing);

    expect(run.error).toMatch(/routine_needs_guardian:/);
    expect((await routines.findById(target))?.enabled).toBe(true);
  });

  it("refuses a visitor", async () => {
    const id = await createRoutine(true);
    const visitor: RoutineTurn = {
      actor: { kind: "visitor", accountId: "v", email: "v@example.test" },
      audience: "private",
    };
    expect((await pause(id, visitor)).status).toBe("error");
  });

  it("refuses a chat that is not private with the guardian", async () => {
    const id = await createRoutine(true);
    const result = await pause(id, { ...guardianAsked, audience: "shared" });
    expect((result as { error: string }).error).toMatch(/^routine_private_only:/);
    expect((await routines.findById(id))?.enabled).toBe(true);
  });
});
