import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { ActionExecutionsRepository } from "../apps/repositories/action-executions.js";
import { RoutineRunsRepository } from "../db/repositories/routine-runs.js";
import { RoutinesRepository } from "../db/repositories/routines.js";
import { createTestDb, type TestDb } from "../test/db.js";
import { callTool, GUARDIAN_TURN } from "../apps/actions/agent-tool-contract.js";
import type { ToolTurn } from "../apps/actions/agent-tool.js";
import { pauseRoutine, resumeRoutine, type RoutineToolDeps } from "./agent-tools.js";
import type { Trigger } from "./types.js";

const guardianAsked = GUARDIAN_TURN;

let testDb: TestDb;
let routines: RoutinesRepository;
let deps: RoutineToolDeps;
const routineEngine = { activate: rs.fn(async () => {}), deactivate: rs.fn(async () => {}) };

beforeEach(() => {
  testDb = createTestDb();
  routines = new RoutinesRepository(testDb.db);
  routineEngine.activate.mockClear();
  routineEngine.deactivate.mockClear();
  deps = {
    routines,
    engine: routineEngine as unknown as RoutineToolDeps["engine"],
    routineRuns: new RoutineRunsRepository(testDb.db),
    actionExecutions: new ActionExecutionsRepository(testDb.db),
    actionRegistry: { has: () => true, isExplicit: () => false, validateArgs: () => null },
    resolveOneOffDate: async (trigger) => trigger,
  };
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

const pause = (routineId: string, turn: ToolTurn = guardianAsked) =>
  callTool(pauseRoutine, deps, { routineId }, turn);
const resume = (routineId: string, turn: ToolTurn = guardianAsked) =>
  callTool(resumeRoutine, deps, { routineId }, turn);

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
      error: expect.stringContaining("system:read_routines"),
    });
  });

  it("asks for the routine's id when none is given", async () => {
    expect(await callTool(pauseRoutine, deps, { routineId: "" })).toEqual({
      status: "error",
      error: "Pass the routine's id as routineId. Find it with system:read_routines.",
    });
  });
});

describe("who may pause or resume a routine", () => {
  it("pauses for a turn no one started and for a member", async () => {
    const turns: ToolTurn[] = [
      {},
      { actor: { kind: "visitor", accountId: "v", email: "v@example.test" } },
    ];
    for (const turn of turns) {
      const id = await createRoutine(true);
      expect(await pause(id, turn)).toMatchObject({ status: "ok" });
      expect((await routines.findById(id))?.enabled).toBe(false);
    }
  });
});
