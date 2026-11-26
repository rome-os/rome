import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { ActionExecutionsRepository } from "../apps/repositories/action-executions.js";
import { RoutineRunsRepository } from "../db/repositories/routine-runs.js";
import { RoutinesRepository } from "../db/repositories/routines.js";
import { createTestDb, type TestDb } from "../test/db.js";
import { callTool, GUARDIAN_TURN } from "../apps/actions/agent-tool-contract.js";
import { type RoutineToolDeps, runRoutine, stopRoutine, stopRoutineRun } from "./agent-tools.js";

const guardianAsked = GUARDIAN_TURN;

let testDb: TestDb;
let routines: RoutinesRepository;
let deps: RoutineToolDeps;
let finishRun: () => void;
const routineEngine = {
  activate: rs.fn(async () => {}),
  deactivate: rs.fn(async () => {}),
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
  deps = {
    routines,
    engine: routineEngine,
    routineRuns: new RoutineRunsRepository(testDb.db),
    actionExecutions: new ActionExecutionsRepository(testDb.db),
    actionRegistry: { has: () => true, isExplicit: () => false, validateArgs: () => null },
    resolveOneOffDate: async (trigger) => trigger,
  };
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

describe("running a routine now", () => {
  it("starts the run and answers with its id without waiting for it to finish", async () => {
    const id = await createRoutine();

    const result = await callTool(runRoutine, deps, { routineId: id }, guardianAsked);

    expect(result).toEqual({
      status: "ok",
      data: { routineId: id, name: "Weekly report", runId: "run-1", started: true },
    });
    expect(routineEngine.runNow).toHaveBeenCalledWith(id, {}, expect.any(Function));
  });

  it("passes its input to the run as a trigger's payload", async () => {
    const id = await createRoutine();

    await callTool(
      runRoutine,
      deps,
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
    const result = await callTool(runRoutine, deps, { routineId: "nope" }, guardianAsked);
    expect(result).toMatchObject({
      status: "error",
      error: expect.stringContaining("read_routines"),
    });
    expect(routineEngine.runNow).not.toHaveBeenCalled();
  });

  it("asks for the routine's id when none is given", async () => {
    const result = await callTool(runRoutine, deps, { routineId: "" }, guardianAsked);
    expect(result).toEqual({
      status: "error",
      error: "Pass the routine's id as routineId. Find it with system:read_routines.",
    });
    expect(routineEngine.runNow).not.toHaveBeenCalled();
  });

  it("runs for a turn no one started, such as a routine's", async () => {
    const id = await createRoutine();
    const result = await callTool(runRoutine, deps, { routineId: id }, { audience: "private" });
    expect(result).toMatchObject({ status: "ok" });
    expect(routineEngine.runNow).toHaveBeenCalledTimes(1);
  });
});

describe("stopping a routine's run", () => {
  it("stops the routine's running run", async () => {
    const id = await createRoutine();

    const result = await callTool(stopRoutineRun, deps, { routineId: id }, guardianAsked);

    expect(result).toEqual({
      status: "ok",
      data: { routineId: id, name: "Weekly report", stopped: true },
    });
    expect(routineEngine.cancelRun).toHaveBeenCalledWith(id);
  });

  it("still stops it under its older name", async () => {
    const id = await createRoutine();

    const result = await callTool(stopRoutine, deps, { routineId: id }, guardianAsked);

    expect(result).toEqual({
      status: "ok",
      data: { routineId: id, name: "Weekly report", stopped: true },
    });
  });

  it("stops it from a shared chat", async () => {
    const id = await createRoutine();
    const result = await callTool(
      stopRoutineRun,
      deps,
      { routineId: id },
      { ...guardianAsked, audience: "shared" },
    );
    expect(result).toMatchObject({ status: "ok" });
    expect(routineEngine.cancelRun).toHaveBeenCalledWith(id);
  });
});
