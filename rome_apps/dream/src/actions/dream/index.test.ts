import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, describe, it, expect, rs } from "@rstest/core";
import type { ActionResult, AppActionRuntimeDeps } from "@rome-os/app-runtime";
import type { AgentRunner } from "../../../../../packages/core/src/core/agent-runner.js";
import { createTestDb, type TestDb } from "../../../../../packages/core/src/test/helpers.js";
import { createRunsRepository } from "../../db/repositories/runs.js";
import { createAction, type DreamDeps } from "./index.js";

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../db/migrations");

const actionConfig = {
  name: "dream",
  type: "custom",
  description: "Daily self-review",
  complexity: "moderate",
  speed: "slow",
  reliability: "high",
  sideEffects: "write",
} as const;

let testDb: TestDb;

beforeEach(() => {
  testDb = createTestDb();
  migrate(testDb.db as never, {
    migrationsFolder: MIGRATIONS_DIR,
    migrationsTable: "__drizzle_migrations_app_dream",
  });
});

afterEach(() => {
  testDb.close();
});

const appDb = () => ({
  connection: testDb.db,
  tablePrefix: "dream",
  tableName: (name: string) => `dream__${name}`,
});

function makeDeps(
  agentMessages: Array<Record<string, unknown>>,
  overrides?: {
    runAction?: (...args: unknown[]) => Promise<ActionResult>;
    listRoutines?: () => Promise<Array<{ actionName: string; name: string }>>;
  },
): AppActionRuntimeDeps<DreamDeps> {
  return {
    agentRunner: {
      async *run() {
        for (const msg of agentMessages) {
          yield msg;
        }
      },
    } as unknown as AgentRunner,
    appContext: {
      db: appDb(),
      runAction: overrides?.runAction ?? rs.fn().mockResolvedValue({ status: "ok" }),
      listRoutines: overrides?.listRoutines ?? rs.fn().mockResolvedValue([]),
    },
  } as unknown as AppActionRuntimeDeps<DreamDeps>;
}

describe("dream", () => {
  it("runs agent and returns summary on success", async () => {
    const deps = makeDeps([
      { type: "text", content: "thinking..." },
      { type: "result", content: "Journal entry written." },
    ]);

    const action = createAction(actionConfig, deps);
    const result = await action.execute({});

    if (result.status !== "ok") throw new Error(`expected ok, got ${result.status}`);
    const data = result.data as { summary: string; windowHours: number };
    expect(data.summary).toBe("Journal entry written.");
    expect(data.windowHours).toBe(24);
  });

  it("returns failure when agent emits an error", async () => {
    const deps = makeDeps([{ type: "error", error: "Model timeout" }]);

    const action = createAction(actionConfig, deps);
    const result = await action.execute({});

    if (result.status !== "error") throw new Error(`expected error, got ${result.status}`);
    expect(result.error).toContain("Model timeout");
  });

  it("uses custom windowHours", async () => {
    const deps = makeDeps([{ type: "result", content: "done" }]);

    const action = createAction(actionConfig, deps);
    const result = await action.execute({ windowHours: 12 });

    if (result.status !== "ok") throw new Error(`expected ok, got ${result.status}`);
    const data = result.data as { windowHours: number };
    expect(data.windowHours).toBe(12);
  });

  it("registers daily schedule when none exists", async () => {
    const runAction = rs.fn().mockResolvedValue({ status: "ok" });
    const listRoutines = rs.fn().mockResolvedValue([]);
    const deps = makeDeps([{ type: "result", content: "done" }], { runAction, listRoutines });

    const action = createAction(actionConfig, deps);
    await action.execute({});

    expect(listRoutines).toHaveBeenCalled();
    expect(runAction).toHaveBeenCalledWith(
      "create_routine",
      expect.objectContaining({
        actionName: "dream",
        trigger: expect.objectContaining({ type: "schedule", rrule: "FREQ=DAILY" }),
      }),
    );
  });

  it("still registers the daily routine when an unrelated dream routine exists", async () => {
    const runAction = rs.fn().mockResolvedValue({ status: "ok" });
    // A different routine that happens to run the `dream` action must not
    // suppress the required daily self-register (dedup is on name, not action).
    const listRoutines = rs.fn().mockResolvedValue([{ actionName: "dream", name: "weekly-dream" }]);
    const deps = makeDeps([{ type: "result", content: "done" }], { runAction, listRoutines });

    const action = createAction(actionConfig, deps);
    await action.execute({});

    expect(runAction).toHaveBeenCalledWith("create_routine", expect.anything());
  });

  it("skips scheduling when dream event already exists", async () => {
    const runAction = rs.fn().mockResolvedValue({ status: "ok" });
    const listRoutines = rs.fn().mockResolvedValue([{ actionName: "dream", name: "daily-dream" }]);
    const deps = makeDeps([{ type: "result", content: "done" }], { runAction, listRoutines });

    const action = createAction(actionConfig, deps);
    await action.execute({});

    expect(runAction).not.toHaveBeenCalled();
  });

  it("continues even if schedule registration fails", async () => {
    const runAction = rs.fn().mockRejectedValue(new Error("schedule failed"));
    const listRoutines = rs.fn().mockResolvedValue([]);
    const deps = makeDeps([{ type: "result", content: "done" }], { runAction, listRoutines });

    const action = createAction(actionConfig, deps);
    const result = await action.execute({});

    expect(result.status).toBe("ok");
  });

  it("continues when create_routine reports a soft failure", async () => {
    // create_routine returns { status: "error" } rather than throwing; the dream
    // run must still complete (registration failure is non-fatal) and must not
    // treat the soft failure as a scheduled routine.
    const runAction = rs.fn().mockResolvedValue({ status: "error", error: "bad trigger" });
    const listRoutines = rs.fn().mockResolvedValue([]);
    const deps = makeDeps([{ type: "result", content: "done" }], { runAction, listRoutines });

    const action = createAction(actionConfig, deps);
    const result = await action.execute({});

    expect(result.status).toBe("ok");
    expect(runAction).toHaveBeenCalledWith("create_routine", expect.anything());
  });
  it("records the run and the files its agent changed", async () => {
    const deps = makeDeps([
      {
        type: "tool_use",
        id: "t1",
        tool: "Edit",
        input: { file_path: "/p/memory/MEMORY.md", old_string: "a", new_string: "b" },
      },
      { type: "tool_result", toolUseId: "t1", tool: "Edit", output: "ok" },
      {
        type: "tool_use",
        id: "t2",
        tool: "Edit",
        input: { file_path: "/p/memory/IDENTITY.md", old_string: "x", new_string: "y" },
      },
      { type: "tool_result", toolUseId: "t2", tool: "Edit", output: "no match", isError: true },
      {
        type: "tool_use",
        id: "t3",
        tool: "Write",
        input: { file_path: "/p/memory/journal/2026/10/06.md", content: "# Journal" },
      },
      { type: "tool_result", toolUseId: "t3", tool: "Write", output: "ok" },
      { type: "result", content: "Wrote the journal." },
    ]);

    const result = await createAction(actionConfig, deps).execute({});

    if (result.status !== "ok") throw new Error(`expected ok, got ${result.status}`);
    const { runId } = result.data as { runId: string };
    const runs = createRunsRepository(appDb());
    expect(runs.byId(runId)).toMatchObject({
      kind: "dream",
      status: "completed",
      summary: "Wrote the journal.",
    });
    // The failed edit changed nothing, so it is not recorded.
    expect(runs.changes(runId).map((c) => c.path)).toEqual([
      "/p/memory/MEMORY.md",
      "/p/memory/journal/2026/10/06.md",
    ]);
  });

  it("reports into a run the page already created", async () => {
    const runs = createRunsRepository(appDb());
    const runId = runs.start({ kind: "dream", windowHours: 24 });
    const deps = makeDeps([{ type: "result", content: "done" }]);

    const result = await createAction(actionConfig, deps).execute({ runId });

    if (result.status !== "ok") throw new Error(`expected ok, got ${result.status}`);
    expect((result.data as { runId: string }).runId).toBe(runId);
    expect(runs.listRecent({ limit: 10 })).toHaveLength(1);
    expect(runs.byId(runId)?.status).toBe("completed");
  });

  it("marks the run interrupted when the agent turn is stopped", async () => {
    const deps = makeDeps([
      { type: "result", content: "partial" },
      { type: "turn_end", turnId: "t", status: "interrupted", durationMs: 5 },
    ]);

    await createAction(actionConfig, deps).execute({});

    const [run] = createRunsRepository(appDb()).listRecent({ limit: 1 });
    expect(run).toMatchObject({ status: "interrupted", summary: "partial" });
  });

  it("marks the run failed when the agent fails", async () => {
    const deps = makeDeps([{ type: "error", error: "Model timeout" }]);

    await createAction(actionConfig, deps).execute({});

    const [run] = createRunsRepository(appDb()).listRecent({ limit: 1 });
    expect(run).toMatchObject({ status: "failed", error: "Model timeout" });
    expect(run?.finishedAt).toBeInstanceOf(Date);
  });
});
