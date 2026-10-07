import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, describe, it, expect } from "@rstest/core";
import type { AppActionRuntimeDeps } from "@rome-os/app-runtime";
import { createTestDb, type TestDb } from "../../../../../packages/core/src/test/helpers.js";
import type { AgentRunner } from "../../../../../packages/core/src/core/agent-runner.js";
import { createRunsRepository } from "../../db/repositories/runs.js";
import { createAction } from "./index.js";

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../db/migrations");

const actionConfig = {
  name: "skill_review",
  type: "custom",
  description: "Reviews session and saves skill",
  complexity: "moderate",
  speed: "slow",
  reliability: "high",
  sideEffects: "write",
} as const;

let testDb: TestDb;
let carrierDir: string;
let installCalls: Array<Record<string, unknown>>;
let installResult: { status: "ok"; data: unknown } | { status: "error"; error: string };

beforeEach(() => {
  carrierDir = join(mkdtempSync(join(tmpdir(), "skill-review-")), "user-skills");
  installCalls = [];
  installResult = { status: "ok", data: {} };
  testDb = createTestDb();
  migrate(testDb.db as never, {
    migrationsFolder: MIGRATIONS_DIR,
    migrationsTable: "__drizzle_migrations_app_dream",
  });
});

afterEach(() => {
  testDb.close();
  rmSync(dirname(carrierDir), { recursive: true, force: true });
});

const appDb = () => ({
  connection: testDb.db,
  tablePrefix: "dream",
  tableName: (name: string) => `dream__${name}`,
});

function seedSession(id: string, type: string, createdAt: number, name = id): void {
  testDb.db.run(sql`
    INSERT INTO rome_sessions (id, name, type, created_at, activity_at)
    VALUES (${id}, ${name}, ${type}, ${createdAt}, ${createdAt})
  `);
}

function makeDeps(
  agentMessages: Array<Record<string, unknown>>,
  runCalls: Array<{ prompt: string; workingDir?: string }> = [],
  beforeEvents: () => void = () => {},
): AppActionRuntimeDeps<{ agentRunner: AgentRunner; carrierDir: string }> {
  return {
    carrierDir,
    agentRunner: {
      async *run(params: { prompt: string; workingDir?: string }) {
        runCalls.push(params);
        beforeEvents();
        for (const msg of agentMessages) {
          yield msg;
        }
      },
    } as unknown as AgentRunner,
    appContext: {
      db: appDb(),
      async runAction(name: string, args: Record<string, unknown>) {
        installCalls.push({ name, ...args });
        return installResult;
      },
    },
  } as unknown as AppActionRuntimeDeps<{ agentRunner: AgentRunner; carrierDir: string }>;
}

/** Agent events for a successful Write, after placing the file on disk. */
function writeSkill(name: string): { events: Array<Record<string, unknown>>; place: () => void } {
  const path = join(carrierDir, "skills", name, "SKILL.md");
  const content = `---\nname: ${name}\ndescription: ${name}\n---\n`;
  return {
    place: () => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content);
    },
    events: [
      { type: "tool_use", id: "t1", tool: "Write", input: { file_path: path, content } },
      { type: "tool_result", toolUseId: "t1", tool: "Write", output: "ok" },
      { type: "result", content: `Saved ${name}.` },
    ],
  };
}

describe("skill_review", () => {
  it("returns agent result on success", async () => {
    seedSession("webchat-session-1", "webchat", 1700000000);
    const deps = makeDeps([
      { type: "session_init", sessionId: "agent-session-1" },
      { type: "result", content: "Nothing to update." },
    ]);

    const result = await createAction(actionConfig, deps).execute({});

    if (result.status !== "ok") throw new Error(`expected ok, got ${result.status}`);
    const data = result.data as { result: string };
    expect(data.result).toBe("Nothing to update.");
  });

  it("returns failure when agent emits an error", async () => {
    seedSession("webchat-session-1", "webchat", 1700000000);
    const deps = makeDeps([{ type: "error", error: "Model API failure" }]);

    const result = await createAction(actionConfig, deps).execute({});

    if (result.status !== "error") throw new Error(`expected error, got ${result.status}`);
    expect(result.error).toContain("Model API failure");
    const [run] = createRunsRepository(appDb()).listRecent({ limit: 1 });
    expect(run).toMatchObject({ status: "failed", error: "Model API failure" });
  });

  it("marks the run interrupted when the agent turn is stopped", async () => {
    seedSession("webchat-session-1", "webchat", 1700000000);
    const deps = makeDeps([
      { type: "result", content: "" },
      { type: "turn_end", turnId: "t", status: "interrupted", durationMs: 5 },
    ]);

    await createAction(actionConfig, deps).execute({});

    const [run] = createRunsRepository(appDb()).listRecent({ limit: 1 });
    expect(run?.status).toBe("interrupted");
  });

  it("records an error followed by an interrupted turn as interrupted", async () => {
    seedSession("webchat-session-1", "webchat", 1700000000);
    const deps = makeDeps([
      { type: "error", error: "aborted" },
      { type: "turn_end", turnId: "t", status: "interrupted", durationMs: 5 },
    ]);

    await createAction(actionConfig, deps).execute({});

    const [run] = createRunsRepository(appDb()).listRecent({ limit: 1 });
    expect(run?.status).toBe("interrupted");
  });

  it("returns early when no webchat sessions exist", async () => {
    const result = await createAction(actionConfig, makeDeps([])).execute({});

    if (result.status !== "ok") throw new Error(`expected ok, got ${result.status}`);
    const data = result.data as { result: string };
    expect(data.result).toBe("No webchat sessions found.");
    expect(createRunsRepository(appDb()).listRecent({ limit: 1 })).toEqual([]);
  });

  it("uses explicit sessionId when provided", async () => {
    seedSession("newer-session", "webchat", 1700000100);
    seedSession("explicit-session-42", "webchat", 1700000000, "Fix the deploy script");
    const runCalls: Array<{ prompt: string }> = [];

    await createAction(
      actionConfig,
      makeDeps([{ type: "result", content: "done" }], runCalls),
    ).execute({
      sessionId: "explicit-session-42",
    });

    expect(runCalls).toHaveLength(1);
    expect(runCalls[0].prompt).toContain("explicit-session-42");
    const [run] = createRunsRepository(appDb()).listRecent({ limit: 1 });
    expect(run).toMatchObject({
      reviewedSessionId: "explicit-session-42",
      reviewedSessionName: "Fix the deploy script",
    });
  });

  it("reviews the newest webchat session, not a newer channel or background run", async () => {
    seedSession("older-web", "webchat", 1700000000);
    seedSession("newest-web", "webchat", 1700000100);
    seedSession("group-chat", "channel", 1700000200);
    seedSession("dream-run", "action", 1700000300);
    const runCalls: Array<{ prompt: string }> = [];

    const result = await createAction(
      actionConfig,
      makeDeps([{ type: "result", content: "done" }], runCalls),
    ).execute({});

    if (result.status !== "ok") throw new Error(`expected ok, got ${result.status}`);
    expect(runCalls).toHaveLength(1);
    expect(runCalls[0].prompt).toContain("newest-web");
  });

  it("runs the agent in a scaffolded user-skills carrier", async () => {
    seedSession("web", "webchat", 1700000000);
    const runCalls: Array<{ prompt: string; workingDir?: string }> = [];

    await createAction(
      actionConfig,
      makeDeps([{ type: "result", content: "Nothing to update." }], runCalls),
    ).execute({});

    expect(runCalls[0].workingDir).toBe(carrierDir);
    expect(runCalls[0].prompt).toContain(carrierDir);
    expect(readFileSync(join(carrierDir, "app.yaml"), "utf8")).toContain("id: user-skills");
    expect(installCalls).toEqual([]);
  });

  it("registers and installs a skill saved in the carrier", async () => {
    seedSession("web", "webchat", 1700000000);
    const skill = writeSkill("deploy-preview");

    const result = await createAction(
      actionConfig,
      makeDeps(skill.events, [], skill.place),
    ).execute({});

    if (result.status !== "ok") throw new Error(`expected ok, got ${JSON.stringify(result)}`);
    expect(result.data).toMatchObject({ installed: ["skills/deploy-preview"] });
    expect(readFileSync(join(carrierDir, "app.yaml"), "utf8")).toContain(
      "skills:\n  - skills/deploy-preview\n",
    );
    expect(installCalls).toEqual([
      { name: "app_management", op: "install", source: { mode: "source", path: carrierDir } },
    ]);
    const { runId } = result.data as { runId: string };
    const runs = createRunsRepository(appDb());
    expect(runs.byId(runId)).toMatchObject({ kind: "skill_review", status: "completed" });
    expect(runs.changes(runId)).toHaveLength(1);
  });

  it("fails the run when the carrier install fails", async () => {
    seedSession("web", "webchat", 1700000000);
    installResult = { status: "error", error: "BUILD_FAILED" };
    const skill = writeSkill("deploy-preview");

    const result = await createAction(
      actionConfig,
      makeDeps(skill.events, [], skill.place),
    ).execute({});

    if (result.status !== "error") throw new Error(`expected error, got ${result.status}`);
    expect(result.error).toContain("BUILD_FAILED");
    const [run] = createRunsRepository(appDb()).listRecent({ limit: 1 });
    expect(run).toMatchObject({ status: "failed" });
  });

  it("does not install for writes outside the carrier", async () => {
    seedSession("web", "webchat", 1700000000);
    const outside = "/repo/rome_apps/coding/src/skills/deploy/SKILL.md";

    await createAction(
      actionConfig,
      makeDeps([
        { type: "tool_use", id: "t1", tool: "Write", input: { file_path: outside, content: "x" } },
        { type: "tool_result", toolUseId: "t1", tool: "Write", output: "ok" },
        { type: "result", content: "done" },
      ]),
    ).execute({});

    expect(installCalls).toEqual([]);
  });
});
