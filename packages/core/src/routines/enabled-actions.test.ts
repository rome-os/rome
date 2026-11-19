import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { ActionEngine, type ActionRunContext } from "../apps/actions/engine.js";
import { ActionRegistryImpl } from "../apps/actions/registry.js";
import { RoutinesRepository } from "../db/repositories/routines.js";
import { createActionEngineRepos, createTestDb, type TestDb } from "../test/db.js";
import {
  registerRoutineEnabledActions,
  ROUTINE_PAUSE_ACTION,
  ROUTINE_RESUME_ACTION,
} from "./enabled-actions.js";
import type { Trigger } from "./types.js";

const guardianAsked: ActionRunContext = {
  actor: { kind: "guardian", userId: "guardian", via: "cookie" },
  audience: "private",
};

let testDb: TestDb;
let routines: RoutinesRepository;
let engine: ActionEngine;
const routineEngine = { activate: rs.fn(async () => {}), deactivate: rs.fn(async () => {}) };

beforeEach(() => {
  testDb = createTestDb();
  routines = new RoutinesRepository(testDb.db);
  routineEngine.activate.mockClear();
  routineEngine.deactivate.mockClear();
  const registry = new ActionRegistryImpl();
  registerRoutineEnabledActions(registry, { routines, engine: routineEngine });
  engine = new ActionEngine(registry, createActionEngineRepos(testDb.db), {
    processRole: "main",
    workerWarmPoolSize: 0,
    isFirstPartyAction: (name) => name === ROUTINE_PAUSE_ACTION || name === ROUTINE_RESUME_ACTION,
    actionWorkerFork: rs.fn(() => {
      throw new Error("Pausing a routine must run in main");
    }),
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

const pause = (routineId: string, context: ActionRunContext = guardianAsked) =>
  engine.run(ROUTINE_PAUSE_ACTION, { routineId }, context);
const resume = (routineId: string, context: ActionRunContext = guardianAsked) =>
  engine.run(ROUTINE_RESUME_ACTION, { routineId }, context);

describe("core:routine_pause and core:routine_resume", () => {
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
    expect(await engine.run(ROUTINE_PAUSE_ACTION, { id: "a-routine" }, guardianAsked)).toEqual({
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

  it("refuses a visitor", async () => {
    const id = await createRoutine(true);
    const visitor: ActionRunContext = {
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
