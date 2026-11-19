import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { ActionEngine, type ActionRunContext } from "../apps/actions/engine.js";
import { ActionRegistryImpl } from "../apps/actions/registry.js";
import { ActionExecutionsRepository } from "../apps/repositories/action-executions.js";
import { routineRuns as routineRunsTable } from "../db/schema.js";
import { RoutineRunsRepository } from "../db/repositories/routine-runs.js";
import { RoutinesRepository } from "../db/repositories/routines.js";
import { createActionEngineRepos, createTestDb, type TestDb } from "../test/db.js";
import {
  registerRoutineRunActions,
  ROUTINE_RUN_READ_ACTION,
  ROUTINE_RUNS_LIST_ACTION,
} from "./run-actions.js";

type Actor = NonNullable<ActionRunContext["actor"]>;

const guardian: Actor = { kind: "guardian", userId: "guardian", via: "cookie" };
const visitor: Actor = { kind: "visitor", accountId: "visitor", email: "visitor@example.test" };

let testDb: TestDb;
let routines: RoutinesRepository;
let routineRuns: RoutineRunsRepository;
let actionExecutions: ActionExecutionsRepository;
let registry: ActionRegistryImpl;
let engine: ActionEngine;

beforeEach(async () => {
  testDb = createTestDb();
  routines = new RoutinesRepository(testDb.db);
  routineRuns = new RoutineRunsRepository(testDb.db);
  actionExecutions = new ActionExecutionsRepository(testDb.db);
  registry = new ActionRegistryImpl();
  registerRoutineRunActions(registry, {
    routines,
    routineRuns,
    actionExecutions,
    ownerOfChat: async (chatId) =>
      chatId === "visitor-chat"
        ? "visitor:visitor"
        : chatId === "guardian-chat"
          ? "guardian"
          : null,
  });
  engine = new ActionEngine(registry, createActionEngineRepos(testDb.db), {
    processRole: "main",
    workerWarmPoolSize: 0,
    isFirstPartyAction: (name) => name.startsWith("core:routine_run"),
    actionWorkerFork: rs.fn(() => {
      throw new Error("Reading a routine's runs must run in main");
    }),
  });
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

const list = (args: Record<string, unknown>, context: ActionRunContext = { actor: guardian }) =>
  engine.run(ROUTINE_RUNS_LIST_ACTION, args, context);
const read = (args: Record<string, unknown>, context: ActionRunContext = { actor: guardian }) =>
  engine.run(ROUTINE_RUN_READ_ACTION, args, context);

describe("core:routine_runs_list", () => {
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
    expect(await list({ id: "a-routine" })).toEqual({
      status: "error",
      error: "Pass the routine's id as routineId. Find it with system:search_routine.",
    });
  });
});

describe("core:routine_run_read", () => {
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
        roots: [{ id: "root", actionName: "summon", children: [{ id: "child" }] }],
      },
    });
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

describe("who may read a routine's runs", () => {
  it("refuses a visitor, and a turn no one started in a chat a visitor owns or that is gone", async () => {
    const routineId = await createRoutine();
    expect((await list({ routineId }, { actor: visitor })).status).toBe("error");
    const visitorChat = { channel: "webchat", threadId: "visitor-chat" };
    expect((await list({ routineId }, { channelContext: visitorChat })).status).toBe("error");
    const goneChat = { channel: "webchat", threadId: "gone-chat" };
    expect((await read({ routineId, runId: "x" }, { channelContext: goneChat })).status).toBe(
      "error",
    );
  });

  it("refuses a turn with neither an actor nor a chat", async () => {
    const routineId = await createRoutine();
    expect((await list({ routineId }, {})).status).toBe("error");
  });

  it("reads for a turn no one started in the guardian's chat", async () => {
    const routineId = await createRoutine();
    const guardianChat = { channel: "webchat", threadId: "guardian-chat" };
    expect((await list({ routineId }, { channelContext: guardianChat })).status).toBe("ok");
  });

  it("is available through the main agent wildcard", () => {
    expect(registry.getForAgent(["*"]).map((action) => action.config.name)).toEqual(
      expect.arrayContaining([ROUTINE_RUNS_LIST_ACTION, ROUTINE_RUN_READ_ACTION]),
    );
  });
});
