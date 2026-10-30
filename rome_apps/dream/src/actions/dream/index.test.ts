import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
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
let carrierDir: string;

beforeEach(() => {
  carrierDir = join(mkdtempSync(join(tmpdir(), "dream-")), "user-skills");
  testDb = createTestDb();
  migrate(testDb.db as never, {
    migrationsFolder: MIGRATIONS_DIR,
    migrationsTable: "__drizzle_migrations_app_dream",
  });
  // A scheduled dream only runs after a conversation, so most cases start with one.
  seedMessage({ sessionType: "webchat", role: "user", hoursAgo: 1 });
});

let seededSessions = 0;

function seedMessage(input: {
  sessionType: string;
  role: string;
  hoursAgo: number;
  /** The channel a `channel` session is on. */
  channel?: string;
  senderId?: string;
}): void {
  const sessionId = `session-${++seededSessions}`;
  const createdAt = Math.floor((Date.now() - input.hoursAgo * 60 * 60 * 1000) / 1000);
  testDb.db.run(sql`
    INSERT INTO rome_sessions (id, name, type, source_channel, created_at, activity_at)
    VALUES (${sessionId}, ${sessionId}, ${input.sessionType}, ${input.channel ?? null}, ${createdAt}, ${createdAt})
  `);
  testDb.db.run(sql`
    INSERT INTO rome_agent_messages (id, session_id, role, content, sender_id, created_at)
    VALUES (${`${sessionId}-message`}, ${sessionId}, ${input.role}, '"hi"', ${input.senderId ?? null}, ${createdAt})
  `);
}

function clearChats(): void {
  testDb.db.run(sql`DELETE FROM rome_agent_messages`);
  testDb.db.run(sql`DELETE FROM rome_sessions`);
}

afterEach(() => {
  testDb.close();
  rmSync(dirname(carrierDir), { recursive: true, force: true });
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
    carrierDir,
    memoryDir: "/p/memory",
    // The memory agent plays the scripted events; the practice agent after it
    // finishes without changing anything.
    agentRunner: {
      async *run({ agentName }: { agentName: string }) {
        if (agentName !== "dream") return;
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
    expect(data.windowHours).toBe(74);
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

  it("asks for the chats of every account, not one account by name", async () => {
    const run = rs.fn(async function* (_input: { prompt: string }) {
      yield { type: "result", content: "done" };
    });
    const deps = makeDeps([]);
    (deps.agentRunner as unknown as { run: unknown }).run = run;

    await createAction(actionConfig, deps).execute({ windowHours: 6 });

    const prompt = run.mock.calls[0]?.[0]?.prompt ?? "";
    expect(prompt).toContain("windowHours: 6 to get_webchat_conversations, get_account_chats,");
    expect(prompt).not.toContain("fetch_channel_history");
    expect(prompt.toLowerCase()).not.toContain("discord");
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

  it("records the memory actions that succeeded, not the ones they refused", async () => {
    const call = (id: string, name: string, args: Record<string, unknown>) => ({
      type: "tool_use",
      id,
      tool: "execute_action",
      input: { action_name: name, json_args: args },
    });
    const deps = makeDeps([
      call("ok", "write_memory_file", { path: "/p/memory/topics/a.md", content: "fact" }),
      { type: "tool_result", toolUseId: "ok", tool: "execute_action", output: '{"status":"ok"}' },
      call("no", "edit_memory_file", {
        path: "/p/memory/MEMORY.md",
        old_string: "x",
        new_string: "y",
      }),
      {
        type: "tool_result",
        toolUseId: "no",
        tool: "execute_action",
        output: '{"status":"error","error":"old_string was not found"}',
      },
      { type: "result", content: "done" },
    ]);

    const result = await createAction(actionConfig, deps).execute({});

    const { runId } = (result as { data: { runId: string } }).data;
    expect(
      createRunsRepository(appDb())
        .changes(runId)
        .map((c) => c.path),
    ).toEqual(["/p/memory/topics/a.md"]);
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
    expect(result.data).toMatchObject({ runId: manual, skipped: true, reason: "already_running" });
    expect(run).not.toHaveBeenCalled();
    expect(runs.listRecent({ limit: 10 })).toHaveLength(1);
  });

  describe("without a conversation in the window", () => {
    function agentNeverRuns(deps: AppActionRuntimeDeps<DreamDeps>) {
      const run = rs.fn();
      (deps.agentRunner as unknown as { run: unknown }).run = run;
      return run;
    }

    it("skips a scheduled dream and records no run", async () => {
      clearChats();
      const deps = makeDeps([]);
      const run = agentNeverRuns(deps);

      const result = await createAction(actionConfig, deps).execute({});

      if (result.status !== "ok") throw new Error(`expected ok, got ${result.status}`);
      expect(result.data).toMatchObject({ skipped: true, reason: "no_recent_chat" });
      expect(run).not.toHaveBeenCalled();
      expect(createRunsRepository(appDb()).listRecent({ limit: 10 })).toHaveLength(0);
    });

    it("ignores conversations older than the window", async () => {
      clearChats();
      seedMessage({ sessionType: "webchat", role: "user", hoursAgo: 80 });
      const deps = makeDeps([]);
      const run = agentNeverRuns(deps);

      const result = await createAction(actionConfig, deps).execute({});

      expect(result).toMatchObject({ status: "ok", data: { reason: "no_recent_chat" } });
      expect(run).not.toHaveBeenCalled();
    });

    it("counts only messages a person sent in a chat or on one of Rome's accounts", async () => {
      clearChats();
      seedMessage({ sessionType: "webchat", role: "assistant", hoursAgo: 1 });
      seedMessage({
        sessionType: "channel",
        channel: "telegram",
        role: "notification",
        senderId: "rome",
        hoursAgo: 1,
      });
      seedMessage({ sessionType: "channel", channel: "whatsapp", role: "user", hoursAgo: 1 });
      seedMessage({ sessionType: "action", role: "user", hoursAgo: 1 });
      seedMessage({ sessionType: "subagent", role: "user", hoursAgo: 1 });
      const deps = makeDeps([]);
      const run = agentNeverRuns(deps);

      const result = await createAction(actionConfig, deps).execute({});

      expect(result).toMatchObject({ status: "ok", data: { reason: "no_recent_chat" } });
      expect(run).not.toHaveBeenCalled();
    });

    it("runs when a person messaged Rome on one of its accounts", async () => {
      clearChats();
      seedMessage({ sessionType: "channel", channel: "telegram", role: "user", hoursAgo: 2 });

      const result = await createAction(
        actionConfig,
        makeDeps([{ type: "result", content: "done" }]),
      ).execute({});

      expect(result).toMatchObject({ status: "ok", data: { summary: "done" } });
    });

    it("runs on a line the agent did not answer", async () => {
      clearChats();
      seedMessage({
        sessionType: "channel",
        channel: "feishu",
        role: "notification",
        senderId: "ou_123",
        hoursAgo: 2,
      });

      const result = await createAction(
        actionConfig,
        makeDeps([{ type: "result", content: "done" }]),
      ).execute({});

      expect(result).toMatchObject({ status: "ok", data: { summary: "done" } });
    });

    it("measures the window from windowHours", async () => {
      clearChats();
      seedMessage({ sessionType: "webchat", role: "user", hoursAgo: 30 });

      const result = await createAction(
        actionConfig,
        makeDeps([{ type: "result", content: "done" }]),
      ).execute({ windowHours: 48 });

      expect(result).toMatchObject({ status: "ok", data: { summary: "done" } });
    });

    it("still runs a dream the guardian started from the page", async () => {
      clearChats();
      const runs = createRunsRepository(appDb());
      const { id: runId } = runs.reserveDream(24, "queued");

      const result = await createAction(
        actionConfig,
        makeDeps([{ type: "result", content: "done" }]),
      ).execute({ runId });

      expect(result).toMatchObject({ status: "ok", data: { runId, summary: "done" } });
      expect(runs.byId(runId)?.status).toBe("completed");
    });
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
    const run = rs.fn(async function* (_input: { agentName: string }) {
      yield { type: "result", content: "done" };
    });
    const deps = makeDeps([]);
    (deps.agentRunner as unknown as { run: unknown }).run = run;
    const action = createAction(actionConfig, deps);

    const results = await Promise.all([action.execute({ runId }), action.execute({ runId })]);

    expect(run.mock.calls.map(([input]) => input.agentName)).toEqual(["dream", "dream-practice"]);
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
    expect(run).toMatchObject({ status: "failed", error: "Memory agent failed: Model timeout" });
    expect(run?.finishedAt).toBeInstanceOf(Date);
  });
});

describe("dream skills", () => {
  const SKILL = "---\nname: rename-invoices\ndescription: Rename invoice PDFs\n---\n\n## Steps\n";

  /**
   * A memory agent that finishes quietly, then a practice agent that writes
   * `rename-invoices` into the staging dir its prompt names and plays `events`.
   * `events` also ends the memory agent when it is an error.
   */
  function skillWritingRunner(
    events: Array<Record<string, unknown>>,
    practice?: (appsDir: string) => void,
  ) {
    const prompts: string[] = [];
    const agents: string[] = [];
    const run = async function* (params: { agentName: string; prompt: string }) {
      prompts.push(params.prompt);
      agents.push(params.agentName);
      if (params.agentName === "dream") {
        for (const event of events) if (event.type === "error") yield event;
        return;
      }
      const staging = /Skills staging directory: (.+)$/m.exec(params.prompt)?.[1] as string;
      mkdirSync(join(staging, "rename-invoices"), { recursive: true });
      writeFileSync(join(staging, "rename-invoices", "SKILL.md"), SKILL);
      practice?.(/Guardian's apps directory: (.+)$/m.exec(params.prompt)?.[1] as string);
      for (const event of events) yield event;
    };
    return { run, prompts, agents };
  }

  function withRunner(
    runner: ReturnType<typeof skillWritingRunner>,
    runAction = rs.fn().mockResolvedValue({ status: "ok" }),
  ) {
    const deps = makeDeps([], { runAction });
    (deps.agentRunner as unknown as { run: unknown }).run = runner.run;
    return { deps, runAction };
  }

  it("runs the memory agent, then the practice agent, each with its paths", async () => {
    const runner = skillWritingRunner([{ type: "result", content: "done" }]);
    const { deps } = withRunner(runner);

    await createAction(actionConfig, deps).execute({ windowHours: 6 });

    expect(runner.agents).toEqual(["dream", "dream-practice"]);
    const [memory = "", practice = ""] = runner.prompts;
    expect(memory).toContain("windowHours: 6 to get_webchat_conversations, get_account_chats,");
    expect(memory).toContain("Memory directory: /p/memory");
    expect(memory).toContain(`Today's journal entry: ${join("/p/memory", "journal")}`);
    expect(memory).toMatch(/journal[\\/]\d{4}[\\/]\d{2}[\\/]\d{2}\.md/);
    expect(memory).not.toContain("apps directory");
    expect(practice).toContain("windowHours: 6 to get_webchat_conversations and get_action_logs");
    expect(practice).not.toContain("get_account_chats");
    expect(practice).toMatch(/Skills staging directory: .*\.dream-skill-review-.*[\\/]skills$/m);
    expect(practice).toContain(`Guardian's apps directory: ${dirname(carrierDir)}`);
    // The memory agent wrote memory and the journal from other people's chats.
    expect(practice).not.toContain("/p/memory");
    expect(practice).toMatch(/Practice notes file: .*\.dream-skill-review-.*[\\/]practice\.md$/m);
  });

  it("appends the practice agent's notes to today's journal", async () => {
    const memoryDir = mkdtempSync(join(tmpdir(), "dream-memory-"));
    const runner = skillWritingRunner([{ type: "result", content: "done" }], () => {
      const notes = /Practice notes file: (.+)$/m.exec(runner.prompts[1] ?? "")?.[1] as string;
      writeFileSync(notes, "## Practice\n- notes app: fixed the export.");
    });
    const { deps } = withRunner(runner);
    deps.memoryDir = memoryDir;

    const result = await createAction(actionConfig, deps).execute({});

    const journalPath = /Today's journal entry: (.+)$/m.exec(
      runner.prompts[0] ?? "",
    )?.[1] as string;
    expect(readFileSync(journalPath, "utf8")).toContain(
      "## Practice\n- notes app: fixed the export.",
    );
    const { runId } = (result as { data: { runId: string } }).data;
    expect(
      createRunsRepository(appDb())
        .changes(runId)
        .map((c) => c.path),
    ).toContain(journalPath);
  });

  it("records the app files the practice agent changed without file tools", async () => {
    const apps = dirname(carrierDir);
    mkdirSync(join(apps, "notes/src"), { recursive: true });
    writeFileSync(join(apps, "notes/src/old.ts"), "old");
    writeFileSync(join(apps, "notes/src/same.ts"), "same");
    writeFileSync(join(apps, "notes/src/gone.ts"), "removed by the agent");
    writeFileSync(join(apps, "notes/src/elsewhere.ts"), "before unrelated edit");
    // An Edit, then a Bash write the recorder does not see, to the same file.
    const editEvents = [
      {
        type: "tool_use",
        id: "e1",
        tool: "Edit",
        input: { file_path: join(apps, "notes/src/old.ts"), old_string: "old", new_string: "mid" },
      },
      { type: "tool_result", toolUseId: "e1", tool: "Edit", output: "ok" },
    ];
    const deleteEvents = [
      {
        type: "tool_use",
        id: "d1",
        tool: "Edit",
        input: {
          type: "fileChange",
          changes: [
            {
              path: join(apps, "notes/src/gone.ts"),
              kind: { type: "delete" },
              diff: "-removed by the agent\n",
            },
          ],
        },
      },
      { type: "tool_result", toolUseId: "d1", tool: "Edit", output: "ok" },
    ];
    const sharedPath = join(apps, "calendar/src/shared.ts");
    const writeEvents = [
      {
        type: "tool_use",
        id: "w1",
        tool: "Write",
        input: { file_path: sharedPath, content: "practice's final content" },
      },
      { type: "tool_result", toolUseId: "w1", tool: "Write", output: "ok" },
    ];
    const runner = skillWritingRunner(
      [...editEvents, ...writeEvents, ...deleteEvents, { type: "result", content: "Fixed notes." }],
      () => {
        const calendar = join(apps, "calendar");
        mkdirSync(join(calendar, "src"), { recursive: true });
        writeFileSync(join(calendar, "src/shared.ts"), "created by app management");
        writeFileSync(join(calendar, "src/other.ts"), "created by app management");
        writeFileSync(sharedPath, "practice's final content");
        // A separate guardian chat can edit an existing app without a tool event here.
        writeFileSync(join(apps, "notes/src/elsewhere.ts"), "edited outside practice");
        writeFileSync(join(apps, "notes/src/fix.ts"), "export const fixed = true;");
        rmSync(join(apps, "notes/src/gone.ts"));
        writeFileSync(join(apps, "notes/.gitignore"), "dist\n");
        writeFileSync(join(apps, "notes/.env"), "API_KEY=secret");
        mkdirSync(join(apps, "notes/.git"), { recursive: true });
        writeFileSync(join(apps, "notes/.git/HEAD"), "ref");
        writeFileSync(join(apps, "notes/src/old.ts"), "new");
        mkdirSync(join(apps, "notes/node_modules/dep"), { recursive: true });
        writeFileSync(join(apps, "notes/node_modules/dep/index.js"), "dep");
      },
    );
    const { deps } = withRunner(runner);

    const result = await createAction(actionConfig, deps).execute({});

    const { runId } = (result as { data: { runId: string } }).data;
    const changes = createRunsRepository(appDb()).changes(runId);
    // The last change to a file is its final state on disk.
    const byPath = (path: string) => changes.findLast((c) => c.path === join(apps, path));
    expect(byPath("notes/src/fix.ts")).toMatchObject({
      op: "write",
      content: "export const fixed = true;",
    });
    // This records that practice touched the file, not that practice was its only writer.
    expect(byPath("calendar/src/shared.ts")).toMatchObject({
      content: "practice's final content",
      attribution: "practice",
    });
    expect(byPath("calendar/src/other.ts")).toMatchObject({ attribution: "unattributed" });
    expect(byPath("notes/src/elsewhere.ts")).toMatchObject({
      op: "edit",
      previous: "before unrelated edit",
      content: "edited outside practice",
      attribution: "unattributed",
    });
    // A modified file shows as a diff against its text before the run.
    expect(byPath("notes/src/old.ts")).toMatchObject({
      op: "edit",
      previous: "old",
      content: "new",
      attribution: "practice",
    });
    // Hidden files are source; a .env is recorded without its contents; .git is skipped.
    expect(byPath("notes/.gitignore")).toMatchObject({ op: "write", content: "dist\n" });
    expect(byPath("notes/.env")).toMatchObject({ content: "(contents not recorded)" });
    expect(JSON.stringify(changes)).not.toContain("API_KEY");
    // A deleted file shows as an edit to empty, against its text before the run.
    expect(byPath("notes/src/gone.ts")).toMatchObject({
      op: "edit",
      previous: "removed by the agent",
      content: "",
      attribution: "practice",
    });
    expect(byPath("notes/src/fix.ts")).toMatchObject({ attribution: "unattributed" });
    // One record per changed file: the Edit the recorder saw is not stored twice.
    expect(changes.filter((c) => c.path.startsWith(join(apps, "notes")))).toHaveLength(6);
  });

  it("shows the practice agent its notes from earlier runs", async () => {
    const memoryDir = mkdtempSync(join(tmpdir(), "dream-memory-"));
    async function dreamWithNotes(text: string): Promise<string> {
      const prompts: string[] = [];
      const run = async function* (params: { agentName: string; prompt: string }) {
        prompts.push(params.prompt);
        if (params.agentName === "dream-practice") {
          const notes = /Practice notes file: (.+)$/m.exec(params.prompt)?.[1] as string;
          writeFileSync(notes, text);
        }
        yield { type: "result", content: "done" };
      };
      const deps = makeDeps([]);
      deps.memoryDir = memoryDir;
      (deps.agentRunner as unknown as { run: unknown }).run = run;
      await createAction(actionConfig, deps).execute({});
      return prompts[1] ?? "";
    }

    const first = await dreamWithNotes("## Practice\n- reported the export bug");
    await dreamWithNotes("## Practice\n- fixed the date picker");
    const third = await dreamWithNotes("## Practice\n- nothing new");

    expect(first).toContain("(None yet.)");
    expect(third.indexOf("- reported the export bug")).toBeGreaterThan(0);
    expect(third.indexOf("- fixed the date picker")).toBeGreaterThan(
      third.indexOf("- reported the export bug"),
    );
    expect(third).not.toContain("- nothing new");
  });

  it("stages skills only after the memory agent, and never takes its edits for practice notes", async () => {
    const memoryDir = mkdtempSync(join(tmpdir(), "dream-memory-"));
    const journal = (prompt: string) => /Today's journal entry: (.+)$/m.exec(prompt)?.[1] as string;
    const prompts: string[] = [];
    let stagingDuringMemory: string[] = [];
    const run = async function* (params: { agentName: string; prompt: string }) {
      prompts.push(params.prompt);
      if (params.agentName === "dream") {
        stagingDuringMemory = readdirSync(dirname(carrierDir)).filter((name) =>
          name.startsWith(".dream-skill-review-"),
        );
        // An Edit of an empty journal records an empty previous text.
        mkdirSync(dirname(journal(params.prompt)), { recursive: true });
        writeFileSync(journal(params.prompt), "");
        yield {
          type: "tool_use",
          id: "e1",
          tool: "Edit",
          input: { file_path: journal(params.prompt), old_string: "", new_string: "relayed text" },
        };
        yield { type: "tool_result", toolUseId: "e1", tool: "Edit", output: "ok" };
      }
      yield { type: "result", content: "done" };
    };
    for (let i = 0; i < 2; i++) {
      const deps = makeDeps([]);
      deps.memoryDir = memoryDir;
      (deps.agentRunner as unknown as { run: unknown }).run = run;
      await createAction(actionConfig, deps).execute({});
    }

    expect(stagingDuringMemory).toEqual([]);
    expect(prompts[3]).toContain("(None yet.)");
    expect(prompts[3]).not.toContain("relayed text");
  });

  it("never records the contents of a .env file the agent wrote or edited", async () => {
    const env = join(dirname(carrierDir), "notes/.env");
    const deps = makeDeps([
      { type: "tool_use", id: "w", tool: "Write", input: { file_path: env, content: "KEY=one" } },
      { type: "tool_result", toolUseId: "w", tool: "Write", output: "ok" },
      {
        type: "tool_use",
        id: "e",
        tool: "Edit",
        input: { file_path: env, old_string: "KEY=one", new_string: "KEY=two" },
      },
      { type: "tool_result", toolUseId: "e", tool: "Edit", output: "ok" },
      { type: "result", content: "done" },
    ]);

    const result = await createAction(actionConfig, deps).execute({});

    const { runId } = (result as { data: { runId: string } }).data;
    const recorded = JSON.stringify(createRunsRepository(appDb()).changes(runId));
    expect(recorded).toContain("(contents not recorded)");
    expect(recorded).not.toContain("KEY=");
  });

  it("records thousands of changes in one call", () => {
    const runs = createRunsRepository(appDb());
    const { id } = runs.reserveDream(24, "running");
    const changes = Array.from({ length: 4000 }, (_, i) => ({
      op: "write" as const,
      path: `/apps/a/f${i}.ts`,
      content: String(i),
      previous: null,
      truncated: false,
    }));

    runs.addChanges(id, changes);

    const stored = runs.changes(id);
    expect(stored).toHaveLength(4000);
    expect(stored[3999]?.path).toBe("/apps/a/f3999.ts");
  });

  it("says which agent failed when the practice agent fails", async () => {
    const runner = skillWritingRunner([{ type: "error", error: "Bash denied" }]);
    // Only the practice agent fails: the memory agent plays errors too, so
    // give it a runner of its own.
    const run = async function* (params: { agentName: string; prompt: string }) {
      if (params.agentName === "dream") {
        yield { type: "result", content: "Updated memory." };
        return;
      }
      yield* runner.run(params);
    };
    const deps = makeDeps([]);
    (deps.agentRunner as unknown as { run: unknown }).run = run;

    const result = await createAction(actionConfig, deps).execute({});

    expect(result).toMatchObject({
      status: "error",
      error: "Practice agent (after memory was updated) failed: Bash denied",
    });
  });

  it("installs the skills a completed dream saved, then drops the staging copy", async () => {
    const runner = skillWritingRunner([{ type: "result", content: "Saved a skill." }]);
    const { deps, runAction } = withRunner(runner);

    const result = await createAction(actionConfig, deps).execute({});

    expect(result).toMatchObject({
      status: "ok",
      data: { summary: "Saved a skill.", installed: ["skills/rename-invoices"] },
    });
    expect(readFileSync(join(carrierDir, "skills/rename-invoices/SKILL.md"), "utf8")).toBe(SKILL);
    expect(readFileSync(join(carrierDir, "app.yaml"), "utf8")).toContain("skills/rename-invoices");
    expect(runAction).toHaveBeenCalledWith("app_management", {
      op: "install",
      source: { mode: "source", path: carrierDir },
    });
    const staging = /Skills staging directory: (.+)$/m.exec(runner.prompts[1] ?? "")?.[1] ?? "";
    expect(existsSync(dirname(staging))).toBe(false);
    // The skill was written without a file tool, and still shows on the run.
    const { runId } = (result as { data: { runId: string } }).data;
    expect(createRunsRepository(appDb()).changes(runId)).toContainEqual(
      expect.objectContaining({
        op: "write",
        path: join(carrierDir, "skills/rename-invoices/SKILL.md"),
        content: SKILL,
        attribution: "practice",
      }),
    );
  });

  it("installs nothing from a dream that failed", async () => {
    const runner = skillWritingRunner([{ type: "error", error: "Model timeout" }]);
    const { deps, runAction } = withRunner(runner);

    const result = await createAction(actionConfig, deps).execute({});

    expect(result.status).toBe("error");
    expect(runAction).not.toHaveBeenCalled();
    expect(existsSync(join(carrierDir, "skills/rename-invoices"))).toBe(false);
  });

  it("keeps the dream completed when the skills fail to install, and says so", async () => {
    const runner = skillWritingRunner([{ type: "result", content: "Updated memory." }]);
    const { deps } = withRunner(
      runner,
      rs.fn().mockResolvedValue({ status: "error", error: "build failed" }),
    );

    const result = await createAction(actionConfig, deps).execute({});

    if (result.status !== "ok") throw new Error(`expected ok, got ${result.status}`);
    const data = result.data as { runId: string; skillsError: string; summary: string };
    expect(data.skillsError).toContain("build failed");
    expect(createRunsRepository(appDb()).byId(data.runId)).toMatchObject({
      status: "completed",
      summary: expect.stringContaining("Skills not saved"),
    });
    expect(existsSync(join(carrierDir, "skills/rename-invoices"))).toBe(false);
  });
});
