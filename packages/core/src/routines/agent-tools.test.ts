import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { ActionExecutionsRepository } from "../apps/repositories/action-executions.js";
import { routineRuns as routineRunsTable } from "../db/schema.js";
import { RoutineRunsRepository } from "../db/repositories/routine-runs.js";
import { RoutinesRepository } from "../db/repositories/routines.js";
import { callTool } from "../apps/actions/agent-tool-contract.js";
import { createTestDb, type TestDb } from "../test/db.js";
import {
  changeRoutineTool,
  listRoutineRunsTool,
  pauseRoutine,
  readRoutineRunTool,
  readRoutines,
  resumeRoutine,
  type RoutineToolDeps,
  runRoutine,
  stopRoutine,
  stopRoutineRun,
} from "./agent-tools.js";

let testDb: TestDb;
let routines: RoutinesRepository;
let routineRuns: RoutineRunsRepository;
let actionExecutions: ActionExecutionsRepository;
let deps: RoutineToolDeps;
const engine = { activate: rs.fn(async () => {}), deactivate: rs.fn(async () => {}) };

beforeEach(async () => {
  testDb = createTestDb();
  // Every routine's chat is the guardian's private chat.
  routines = new RoutinesRepository(testDb.db);
  routineRuns = new RoutineRunsRepository(testDb.db);
  actionExecutions = new ActionExecutionsRepository(testDb.db);
  engine.activate.mockClear();
  engine.deactivate.mockClear();
  deps = {
    routines,
    engine: engine as unknown as RoutineToolDeps["engine"],
    routineRuns,
    actionExecutions,
    actionRegistry: {
      has: (name) => name !== "no_such_action",
      isExplicit: () => false,
      validateArgs: (name, args) =>
        name === "system:send_message" && typeof args.text !== "string" ? "text: Required" : null,
    },
    resolveOneOffDate: async (trigger) => trigger,
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

const read = (args: Record<string, unknown>) => callTool(readRoutines, deps, args);
const list = read;
const change = (args: Record<string, unknown>) => callTool(changeRoutineTool, deps, args);

describe("listing the routines", () => {
  it("lists every routine by the routineId the other routine tools take, with what it runs, when, whether it is on, and its latest run", async () => {
    const routineId = await createRoutine();
    const runId = await routineRuns.create({ routineId, executionId: "exec-1", status: "running" });
    await routineRuns.updateStatus(runId, { status: "error", error: "boom" });

    const result = await read({});

    expect(result).toMatchObject({
      status: "ok",
      data: {
        routines: [
          {
            routineId,
            id: routineId,
            name: "Morning briefing",
            enabled: true,
            actionName: "summon",
            trigger: { type: "manual" },
            lastRun: { status: "error", firedAt: expect.any(String) },
          },
        ],
      },
    });
  });

  it("asks for the routine when a run is named without one", async () => {
    expect(await read({ runId: "run-1" })).toMatchObject({ status: "error" });
  });
});

describe("reading one routine and its runs", () => {
  it("returns what the routine runs, with its arguments and trigger", async () => {
    const routineId = await createRoutine();

    const result = await read({ routineId });

    expect(result).toMatchObject({
      status: "ok",
      data: { routine: { actionName: "summon", args: {}, trigger: { type: "manual" } }, runs: [] },
    });
  });

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
        routine: {
          routineId,
          id: routineId,
          name: "Morning briefing",
          enabled: true,
          nextRunAt: null,
        },
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
      error: 'No routine found with id "nope". Use system:read_routines to find the right id.',
    });
  });

  it("names the field to pass when the id comes under another name", async () => {
    const older = (args: Record<string, unknown>) => callTool(listRoutineRunsTool, deps, args);
    expect(await older({ id: "a-routine" })).toMatchObject({
      status: "error",
      error: expect.stringMatching(/routineId/),
    });
    expect(await older({ routineId: " " })).toEqual({
      status: "error",
      error: "Pass the routine's id as routineId. Find it with system:read_routines.",
    });
  });
});

describe("reading one run of a routine", () => {
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

describe("the older names for reading runs", () => {
  it("still lists a routine's runs and reads one", async () => {
    const routineId = await createRoutine();
    const runId = await routineRuns.create({ routineId, executionId: "exec-1", status: "success" });

    expect(await callTool(listRoutineRunsTool, deps, { routineId })).toMatchObject({
      status: "ok",
      data: { routine: { id: routineId }, runs: [{ runId }] },
    });
    expect(await callTool(readRoutineRunTool, deps, { routineId, runId })).toMatchObject({
      status: "ok",
      data: { runId, status: "success" },
    });
  });
});

const createSendRoutine = (overrides: Partial<Parameters<RoutinesRepository["create"]>[0]> = {}) =>
  routines.create({
    name: "Water reminder",
    trigger: {
      type: "schedule",
      tzid: "UTC",
      tzMode: "floating",
      localTime: "09:00",
      rrule: "FREQ=DAILY",
    },
    actionName: "system:send_message",
    args: { threadId: "chat-1", text: "Drink water" },
    enabled: true,
    ...overrides,
  });

describe("changing a routine", () => {
  it("renames it, trimmed", async () => {
    const routineId = await createSendRoutine();

    const result = await change({ routineId, name: "  Hydrate  " });

    expect(result).toMatchObject({ status: "ok", data: { routineId, name: "Hydrate" } });
    expect((await routines.findById(routineId))?.name).toBe("Hydrate");
  });

  it("changes when it runs, and fires on the new schedule from then on", async () => {
    const routineId = await createSendRoutine();
    const trigger = {
      type: "schedule",
      tzid: "UTC",
      tzMode: "floating",
      localTime: "14:30",
      rrule: "FREQ=WEEKLY;BYDAY=MO,FR",
    };

    const result = await change({ routineId, trigger });

    expect(result).toMatchObject({ status: "ok", data: { trigger } });
    expect((await routines.findById(routineId))?.trigger).toEqual(trigger);
    expect(engine.deactivate).toHaveBeenCalledWith(routineId);
    expect(engine.activate).toHaveBeenCalledWith(
      expect.objectContaining({ id: routineId, trigger }),
    );
  });

  it("changes what it does, replacing its arguments", async () => {
    const routineId = await createSendRoutine();

    const result = await change({ routineId, args: { threadId: "chat-1", text: "Stretch" } });

    expect(result).toMatchObject({
      status: "ok",
      data: { actionName: "system:send_message", args: { threadId: "chat-1", text: "Stretch" } },
    });
  });

  it("refuses what a new routine could not run, and keeps the routine as it was", async () => {
    const routineId = await createSendRoutine();

    expect(await change({ routineId, actionName: "no_such_action" })).toMatchObject({
      status: "error",
      error: expect.stringContaining("not a registered action"),
    });
    expect(await change({ routineId, args: { threadId: "chat-1" } })).toEqual({
      status: "error",
      error: "text: Required",
    });
    const trigger = { type: "schedule", tzid: "UTC", tzMode: "floating", localTime: "25:00" };
    expect(await change({ routineId, trigger })).toMatchObject({
      status: "error",
      error: expect.stringContaining("HH:mm"),
    });
    expect((await routines.findById(routineId))?.args).toEqual({
      threadId: "chat-1",
      text: "Drink water",
    });
    expect(engine.activate).not.toHaveBeenCalled();
  });

  it("keeps the chat the routine works for", async () => {
    const routineId = await createSendRoutine();

    expect(
      await change({ routineId, args: { threadId: "chat-2", text: "Drink water" } }),
    ).toMatchObject({ status: "error", error: expect.stringContaining("keeps the chat") });
  });

  it("leaves what an app's routine runs and when to that app, but renames it", async () => {
    const routineId = await createSendRoutine({ managedBy: "dream" });

    expect(await change({ routineId, args: { threadId: "chat-1", text: "x" } })).toMatchObject({
      status: "error",
      error: expect.stringContaining('managed by the "dream" app'),
    });
    expect(await change({ routineId, name: "Dream check" })).toMatchObject({ status: "ok" });
  });

  it.each([
    "concierge-task-schedule:chat-1",
    "concierge-digest:09:00",
    "concierge-follow:github:repo:push",
  ])("leaves what core's %s routine runs and when to the Concierge's records, but renames it", async (key) => {
    const routineId = await createSendRoutine({ key });

    expect(await change({ routineId, args: { threadId: "chat-1", text: "x" } })).toMatchObject({
      status: "error",
      error: expect.stringContaining("follows the Concierge's own records"),
    });
    expect(
      await change({
        routineId,
        trigger: { type: "schedule", tzid: "UTC", localTime: "10:00", rrule: "FREQ=DAILY" },
      }),
    ).toMatchObject({ status: "error" });
    expect(await change({ routineId, name: "Morning check" })).toMatchObject({ status: "ok" });
  });

  it("changes a routine an agent created with its own key", async () => {
    const routineId = await createSendRoutine({ key: "chat-routine:turn-1:tool-1" });

    expect(
      await change({ routineId, args: { threadId: "chat-1", text: "Drink tea" } }),
    ).toMatchObject({ status: "ok" });
  });

  it("asks for what changes, and for a routine that exists", async () => {
    const routineId = await createSendRoutine();

    expect(await change({ routineId })).toEqual({
      status: "error",
      error: "Pass what changes: name, actionName, args or trigger.",
    });
    expect(await change({ routineId: "nope", name: "x" })).toEqual({
      status: "error",
      error: 'No routine found with id "nope". Use system:read_routines to find the right id.',
    });
  });
});
