import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { ActionExecutionsRepository } from "../apps/repositories/action-executions.js";
import { routineRuns as routineRunsTable } from "../db/schema.js";
import { RoutineRunsRepository } from "../db/repositories/routine-runs.js";
import { RoutinesRepository } from "../db/repositories/routines.js";
import { callTool, whoMayAskSuite } from "../apps/actions/agent-tool-contract.js";
import { createTestDb, type TestDb } from "../test/db.js";
import {
  listRoutineRunsTool,
  pauseRoutine,
  readRoutineRunTool,
  resumeRoutine,
  type RoutineToolDeps,
  runRoutine,
  stopRoutine,
} from "./agent-tools.js";

whoMayAskSuite(listRoutineRunsTool, { routineId: "r-1" });
whoMayAskSuite(readRoutineRunTool, { routineId: "r-1", runId: "run-1" });
whoMayAskSuite(pauseRoutine, { routineId: "r-1" });
whoMayAskSuite(resumeRoutine, { routineId: "r-1" });
whoMayAskSuite(runRoutine, { routineId: "r-1" });
whoMayAskSuite(stopRoutine, { routineId: "r-1" });

let testDb: TestDb;
let routines: RoutinesRepository;
let routineRuns: RoutineRunsRepository;
let actionExecutions: ActionExecutionsRepository;
let deps: RoutineToolDeps;

beforeEach(async () => {
  testDb = createTestDb();
  routines = new RoutinesRepository(testDb.db);
  routineRuns = new RoutineRunsRepository(testDb.db);
  actionExecutions = new ActionExecutionsRepository(testDb.db);
  deps = {
    routines,
    engine: {} as RoutineToolDeps["engine"],
    routineRuns,
    actionExecutions,
  };
});

afterEach(() => testDb.close());

const createRoutine = () =>
  routines.create({
    name: "Morning briefing",
    trigger: { type: "manual" },
    actionName: "summon",
    args: {},
    enabled: true,
  });

const list = (args: Record<string, unknown>) => callTool(listRoutineRunsTool, deps, args);
const read = (args: Record<string, unknown>) => callTool(readRoutineRunTool, deps, args);

describe("listing a routine's runs", () => {
  it("returns the routine's state and its runs newest first, with each run's error", async () => {
    const routineId = await createRoutine();
    const first = await routineRuns.create({ routineId, executionId: "exec-1", status: "running" });
    await routineRuns.updateStatus(first, { status: "error", durationMs: 40, error: "boom" });
    // fired_at is second-resolution, so the first run is moved a minute back.
    await testDb.db
      .update(routineRunsTable)
      .set({ firedAt: new Date(Date.now() - 60_000) })
      .where(eq(routineRunsTable.id, first));
    const second = await routineRuns.create({
      routineId,
      executionId: "exec-2",
      status: "success",
    });

    const result = await list({ routineId });

    expect(result).toMatchObject({
      status: "ok",
      data: {
        routine: { id: routineId, name: "Morning briefing", enabled: true, nextRunAt: null },
        runs: [
          { runId: second, status: "success", error: null },
          { runId: first, status: "error", durationMs: 40, error: "boom" },
        ],
      },
    });
  });

  it("says when the routine last ran, counting a run now", async () => {
    const routineId = await createRoutine();
    await routineRuns.create({ routineId, executionId: "exec-1", status: "success" });

    const result = (await list({ routineId })) as { data: { routine: { lastRunAt: string } } };

    expect(result.data.routine.lastRunAt).toEqual(expect.any(String));
  });

  it("returns only as many runs as asked for", async () => {
    const routineId = await createRoutine();
    await routineRuns.create({ routineId, executionId: "exec-1", status: "success" });
    await routineRuns.create({ routineId, executionId: "exec-2", status: "success" });

    const result = await list({ routineId, limit: 1 });

    expect(result.status).toBe("ok");
    expect((result as { data: { runs: unknown[] } }).data.runs).toHaveLength(1);
  });

  it("names the action to find the right id when the routine does not exist", async () => {
    expect(await list({ routineId: "nope" })).toEqual({
      status: "error",
      error: 'No routine found with id "nope". Use system:search_routine to find the right id.',
    });
  });

  it("names the field to pass when the id comes under another name", async () => {
    expect(await list({ id: "a-routine" })).toMatchObject({
      status: "error",
      error: expect.stringMatching(/routineId/),
    });
    expect(await list({ routineId: " " })).toEqual({
      status: "error",
      error: "Pass the routine's id as routineId. Find it with system:search_routine.",
    });
  });
});

describe("reading one run", () => {
  it("returns the run with the actions it ran as a tree", async () => {
    const routineId = await createRoutine();
    const runId = await routineRuns.create({ routineId, executionId: "exec-1", status: "success" });
    await actionExecutions.create({
      id: "root",
      rootExecutionId: "exec-1",
      actionName: "summon",
      status: "success",
    });
    await actionExecutions.create({
      id: "child",
      rootExecutionId: "exec-1",
      parentId: "root",
      actionName: "send_message",
      status: "success",
    });

    const result = await read({ routineId, runId });

    expect(result).toMatchObject({
      status: "ok",
      data: {
        runId,
        status: "success",
        error: null,
        roots: [{ actionName: "summon", children: [{ actionName: "send_message" }] }],
      },
    });
  });

  it("cuts long arguments short and leaves out who ran each action", async () => {
    const routineId = await createRoutine();
    const runId = await routineRuns.create({ routineId, executionId: "exec-1", status: "success" });
    await actionExecutions.create({
      id: "root",
      rootExecutionId: "exec-1",
      actionName: "summon",
      status: "success",
      args: { prompt: "x".repeat(2000) },
    });

    const result = (await read({ routineId, runId })) as {
      data: { roots: Array<Record<string, unknown> & { args: string }> };
    };

    const [root] = result.data.roots;
    expect(root.args.length).toBeLessThanOrEqual(501);
    expect(root).not.toHaveProperty("actor");
    expect(root).not.toHaveProperty("initiator");
  });

  it("refuses a run of another routine", async () => {
    const routineId = await createRoutine();
    const other = await createRoutine();
    const runId = await routineRuns.create({
      routineId: other,
      executionId: "exec-1",
      status: "success",
    });

    expect((await read({ routineId, runId })).status).toBe("error");
  });
});
