import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
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

  it("leaves routines to the app-started hook", async () => {
    const runAction = rs.fn().mockResolvedValue({ status: "ok" });
    const listRoutines = rs.fn().mockResolvedValue([]);
    const deps = makeDeps([{ type: "result", content: "done" }], { runAction, listRoutines });

    const action = createAction(actionConfig, deps);
    await action.execute({});

    expect(listRoutines).not.toHaveBeenCalled();
    expect(runAction).not.toHaveBeenCalled();
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
    const { id: runId } = runs.reserveDream(24, "queued");
    const deps = makeDeps([{ type: "result", content: "done" }]);

    const result = await createAction(actionConfig, deps).execute({ runId });

    if (result.status !== "ok") throw new Error(`expected ok, got ${result.status}`);
    expect((result.data as { runId: string }).runId).toBe(runId);
    expect(runs.listRecent({ limit: 10 })).toHaveLength(1);
    expect(runs.byId(runId)?.status).toBe("completed");
  });

  it("skips a scheduled dream while another dream is running", async () => {
    const runs = createRunsRepository(appDb());
    const manual = runs.start({ kind: "dream", windowHours: 24 });
    const run = rs.fn();
    const deps = makeDeps([]);
    (deps.agentRunner as unknown as { run: unknown }).run = run;

    const result = await createAction(actionConfig, deps).execute({});

    if (result.status !== "ok") throw new Error(`expected ok, got ${result.status}`);
    expect(result.data).toMatchObject({ runId: manual, skipped: true });
    expect(run).not.toHaveBeenCalled();
    expect(runs.listRecent({ limit: 10 })).toHaveLength(1);
  });

  it("does not let a dream whose owner stopped heartbeating block the next one", async () => {
    const runs = createRunsRepository(appDb());
    const stale = runs.start({ kind: "dream", windowHours: 24 });
    testDb.db.run(
      sql`UPDATE dream__runs SET heartbeat_at = ${Date.now() - 20 * 60 * 1000} WHERE id = ${stale}`,
    );

    const result = await createAction(
      actionConfig,
      makeDeps([{ type: "result", content: "done" }]),
    ).execute({});

    if (result.status !== "ok") throw new Error(`expected ok, got ${result.status}`);
    expect((result.data as { runId: string }).runId).not.toBe(stale);
  });

  it("keeps blocking while a long dream is still heartbeating", async () => {
    const runs = createRunsRepository(appDb());
    const live = runs.start({ kind: "dream", windowHours: 24 });
    testDb.db.run(
      sql`UPDATE dream__runs SET started_at = ${Date.now() - 2 * 60 * 60 * 1000} WHERE id = ${live}`,
    );

    const result = await createAction(actionConfig, makeDeps([])).execute({});

    expect(result.status === "ok" && result.data).toMatchObject({ runId: live, skipped: true });
  });

  it("refuses to claim a queued run whose reservation expired", async () => {
    const runs = createRunsRepository(appDb());
    const { id: runId } = runs.reserveDream(24, "queued");
    testDb.db.run(
      sql`UPDATE dream__runs SET heartbeat_at = ${Date.now() - 20 * 60 * 1000} WHERE id = ${runId}`,
    );
    const run = rs.fn();
    const deps = makeDeps([]);
    (deps.agentRunner as unknown as { run: unknown }).run = run;

    const result = await createAction(actionConfig, deps).execute({ runId });

    expect(result.status === "ok" && result.data).toMatchObject({ skipped: true });
    expect(run).not.toHaveBeenCalled();
  });

  it("heartbeats the run while its agent is still working", async () => {
    rs.useFakeTimers({ now: Date.now() });
    try {
      const runs = createRunsRepository(appDb());
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const deps = makeDeps([]);
      (deps.agentRunner as unknown as { run: unknown }).run = async function* () {
        await gate;
        yield { type: "result", content: "done" };
      };

      const pending = createAction(actionConfig, deps).execute({});
      await rs.advanceTimersByTimeAsync(5 * 60 * 1000);
      const [run] = runs.listRecent({ limit: 1 });
      expect(Date.now() - (run?.heartbeatAt?.getTime() ?? 0)).toBeLessThanOrEqual(60 * 1000);

      release();
      await pending;
    } finally {
      rs.useRealTimers();
    }
  });

  it("runs a reserved dream once when two invocations carry its runId", async () => {
    const runs = createRunsRepository(appDb());
    const { id: runId } = runs.reserveDream(24, "queued");
    const run = rs.fn(async function* () {
      yield { type: "result", content: "done" };
    });
    const deps = makeDeps([]);
    (deps.agentRunner as unknown as { run: unknown }).run = run;
    const action = createAction(actionConfig, deps);

    const results = await Promise.all([action.execute({ runId }), action.execute({ runId })]);

    expect(run).toHaveBeenCalledTimes(1);
    expect(
      results.filter((r) => r.status === "ok" && (r.data as { skipped?: boolean }).skipped),
    ).toHaveLength(1);
    expect(runs.byId(runId)?.status).toBe("completed");
  });

  it("records an error followed by an interrupted turn as interrupted", async () => {
    const deps = makeDeps([
      { type: "error", error: "aborted" },
      { type: "turn_end", turnId: "t", status: "interrupted", durationMs: 5 },
    ]);

    await createAction(actionConfig, deps).execute({});

    const [run] = createRunsRepository(appDb()).listRecent({ limit: 1 });
    expect(run?.status).toBe("interrupted");
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
