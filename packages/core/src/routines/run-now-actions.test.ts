import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { ActionEngine, type ActionRunContext } from "../apps/actions/engine.js";
import { actionExecutionContext } from "../apps/actions/context.js";
import { ActionRegistryImpl } from "../apps/actions/registry.js";
import { RoutineRunsRepository } from "../db/repositories/routine-runs.js";
import { RoutinesRepository } from "../db/repositories/routines.js";
import { systemClock } from "../lib/clock.js";
import { createActionEngineRepos, createTestDb, type TestDb } from "../test/db.js";
import {
  registerRoutineRunNowActions,
  ROUTINE_RUN_NOW_ACTION,
  ROUTINE_STOP_ACTION,
} from "./run-now-actions.js";
import { RoutineEngine } from "./engine.js";

const guardianAsked: ActionRunContext = {
  actor: { kind: "guardian", userId: "guardian", via: "cookie" },
  audience: "private",
};

let testDb: TestDb;
let routines: RoutinesRepository;
let engine: ActionEngine;
let finishRun: () => void;
const routineEngine = {
  runNow: rs.fn(
    (_id: string, _payload: Record<string, unknown>, onStarted?: (runId: string) => void) =>
      new Promise<{ runId: string; status: "success" }>((resolve) => {
        onStarted?.("run-1");
        finishRun = () => resolve({ runId: "run-1", status: "success" });
      }),
  ),
  cancelRun: rs.fn(async () => ({ stopped: true, killedLiveProcess: true })),
};

beforeEach(() => {
  testDb = createTestDb();
  // Every routine's chat is the guardian's private chat.
  routines = new RoutinesRepository(testDb.db, async () => "private");
  routineEngine.runNow.mockClear();
  routineEngine.cancelRun.mockClear();
  const registry = new ActionRegistryImpl();
  registerRoutineRunNowActions(registry, { routines, engine: routineEngine });
  engine = new ActionEngine(registry, createActionEngineRepos(testDb.db), {
    processRole: "main",
    workerWarmPoolSize: 0,
    isFirstPartyAction: (name) => name === ROUTINE_RUN_NOW_ACTION || name === ROUTINE_STOP_ACTION,
    actionWorkerFork: rs.fn(() => {
      throw new Error("Running a routine now must run in main");
    }),
  });
});

afterEach(() => {
  finishRun?.();
  testDb.close();
});

const createRoutine = () =>
  routines.create({
    name: "Weekly report",
    trigger: { type: "manual" },
    actionName: "summon",
    args: {},
    enabled: false,
  });

describe("core:routine_run_now", () => {
  it("starts the run and answers with its id without waiting for it to finish", async () => {
    const id = await createRoutine();

    const result = await engine.run(ROUTINE_RUN_NOW_ACTION, { routineId: id }, guardianAsked);

    expect(result).toEqual({
      status: "ok",
      data: { routineId: id, name: "Weekly report", runId: "run-1", started: true },
    });
    expect(routineEngine.runNow).toHaveBeenCalledWith(id, {}, expect.any(Function));
  });

  it("passes its input to the run as a trigger's payload", async () => {
    const id = await createRoutine();

    await engine.run(
      ROUTINE_RUN_NOW_ACTION,
      { routineId: id, input: { repo: "acme/widgets" } },
      guardianAsked,
    );

    expect(routineEngine.runNow).toHaveBeenCalledWith(
      id,
      { repo: "acme/widgets" },
      expect.any(Function),
    );
  });

  it("names the action to find the right id when the routine does not exist", async () => {
    const result = await engine.run(ROUTINE_RUN_NOW_ACTION, { routineId: "nope" }, guardianAsked);
    expect(result).toMatchObject({
      status: "error",
      error: expect.stringContaining("search_routine"),
    });
    expect(routineEngine.runNow).not.toHaveBeenCalled();
  });

  it("names the field to pass when the id comes under another name", async () => {
    const result = await engine.run(ROUTINE_RUN_NOW_ACTION, { id: "a-routine" }, guardianAsked);
    expect(result).toEqual({
      status: "error",
      error: "Pass the routine's id as routineId. Find it with system:search_routine.",
    });
    expect(routineEngine.runNow).not.toHaveBeenCalled();
  });

  it("refuses a turn the guardian's own message did not start, and runs nothing", async () => {
    const id = await createRoutine();
    const result = await engine.run(
      ROUTINE_RUN_NOW_ACTION,
      { routineId: id },
      { audience: "private" },
    );
    expect((result as { error: string }).error).toMatch(/^routine_needs_guardian:/);
    expect(routineEngine.runNow).not.toHaveBeenCalled();
  });
});

describe("a routine's fire", () => {
  it("cannot run a routine, though the guardian made it in their private chat", async () => {
    const id = await actionExecutionContext.run(
      {
        executionId: "e",
        rootExecutionId: "e",
        initiator: "agent:core:main",
        actor: { kind: "guardian", userId: "guardian", via: "cookie" },
      },
      () =>
        routines.create({
          name: "Run myself again",
          trigger: { type: "manual" },
          actionName: ROUTINE_RUN_NOW_ACTION,
          args: {},
          chatId: "guardian-chat",
        }),
    );
    await routines.update(id, { args: { routineId: id } });
    const fires = new RoutineEngine(
      routines,
      new RoutineRunsRepository(testDb.db),
      engine,
      0,
      systemClock,
    );

    const run = await fires.runNow(id);

    expect(run.error).toMatch(/routine_needs_guardian:/);
    expect(routineEngine.runNow).not.toHaveBeenCalled();
  });
});

describe("core:routine_stop", () => {
  it("stops the routine's running run", async () => {
    const id = await createRoutine();

    const result = await engine.run(ROUTINE_STOP_ACTION, { routineId: id }, guardianAsked);

    expect(result).toEqual({
      status: "ok",
      data: { routineId: id, name: "Weekly report", stopped: true },
    });
    expect(routineEngine.cancelRun).toHaveBeenCalledWith(id);
  });

  it("refuses a chat that is not private with the guardian, and stops nothing", async () => {
    const id = await createRoutine();
    const result = await engine.run(
      ROUTINE_STOP_ACTION,
      { routineId: id },
      { ...guardianAsked, audience: "shared" },
    );
    expect((result as { error: string }).error).toMatch(/^routine_private_only:/);
    expect(routineEngine.cancelRun).not.toHaveBeenCalled();
  });
});
