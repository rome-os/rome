import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, it, expect } from "@rstest/core";
import type { AppActionRuntimeDeps } from "@rome-os/app-runtime";
import { createTestDb, type TestDb } from "../../../../../packages/core/src/test/helpers.js";
import type { AgentRunner } from "../../../../../packages/core/src/core/agent-runner.js";
import { createAction } from "./index.js";

const actionConfig = {
  name: "skill_review",
  type: "custom",
  description: "Reviews session and saves skill",
  complexity: "moderate",
  speed: "slow",
  reliability: "high",
  sideEffects: "write",
} as const;

function makeDeps(
  agentMessages: Array<{ type: string; content?: string; error?: string; sessionId?: string }>,
  dbGetResult?: { id: string } | undefined,
): AppActionRuntimeDeps<{ agentRunner: AgentRunner }> {
  return {
    agentRunner: {
      async *run() {
        for (const msg of agentMessages) {
          yield msg;
        }
      },
    } as unknown as AgentRunner,
    appContext: {
      db: {
        connection: {
          get: () => dbGetResult,
        },
      },
    },
  } as unknown as AppActionRuntimeDeps<{ agentRunner: AgentRunner }>;
}

describe("skill_review", () => {
  it("returns agent result on success", async () => {
    const deps = makeDeps(
      [
        { type: "session_init", sessionId: "agent-session-1" },
        { type: "result", content: "Nothing to update." },
      ],
      { id: "webchat-session-1" },
    );

    const action = createAction(actionConfig, deps);
    const result = await action.execute({});

    if (result.status !== "ok") throw new Error(`expected ok, got ${result.status}`);
    const data = result.data as { result: string };
    expect(data.result).toBe("Nothing to update.");
  });

  it("returns failure when agent emits an error", async () => {
    const deps = makeDeps([{ type: "error", error: "Model API failure" }], {
      id: "webchat-session-1",
    });

    const action = createAction(actionConfig, deps);
    const result = await action.execute({});

    if (result.status !== "error") throw new Error(`expected error, got ${result.status}`);
    expect(result.error).toContain("Model API failure");
  });

  it("returns early when no webchat sessions exist", async () => {
    const deps = makeDeps([], undefined);

    const action = createAction(actionConfig, deps);
    const result = await action.execute({});

    if (result.status !== "ok") throw new Error(`expected ok, got ${result.status}`);
    const data = result.data as { result: string };
    expect(data.result).toBe("No webchat sessions found.");
  });

  it("uses explicit sessionId when provided", async () => {
    const runCalls: Array<{ prompt: string }> = [];
    const deps = {
      agentRunner: {
        async *run(params: { prompt: string }) {
          runCalls.push(params);
          yield { type: "result", content: "done" };
        },
      } as unknown as AgentRunner,
      appContext: {
        db: {
          connection: {
            get: () => ({ id: "should-not-be-used" }),
          },
        },
      },
    } as unknown as AppActionRuntimeDeps<{ agentRunner: AgentRunner }>;

    const action = createAction(actionConfig, deps);
    await action.execute({ sessionId: "explicit-session-42" });

    expect(runCalls).toHaveLength(1);
    expect(runCalls[0].prompt).toContain("explicit-session-42");
  });
});

describe("skill_review against the system schema", () => {
  let testDb: TestDb;

  beforeEach(() => {
    testDb = createTestDb();
  });

  afterEach(() => {
    testDb.close();
  });

  function seedSession(id: string, type: string, createdAt: number, activityAt: number): void {
    testDb.db.run(sql`
      INSERT INTO rome_sessions (id, name, type, created_at, activity_at)
      VALUES (${id}, ${id}, ${type}, ${createdAt}, ${activityAt})
    `);
  }

  it("reviews the most recently active guardian conversation, not a channel or background run", async () => {
    seedSession("long-running-web", "webchat", 1700000000, 1700000300);
    seedSession("newer-idle-web", "webchat", 1700000100, 1700000100);
    seedSession("group-chat", "channel", 1700000150, 1700000350);
    seedSession("dream-run", "action", 1700000200, 1700000400);

    const runCalls: Array<{ prompt: string }> = [];
    const deps = {
      agentRunner: {
        async *run(params: { prompt: string }) {
          runCalls.push(params);
          yield { type: "result", content: "done" };
        },
      } as unknown as AgentRunner,
      appContext: { db: { connection: testDb.db } },
    } as unknown as AppActionRuntimeDeps<{ agentRunner: AgentRunner }>;

    const result = await createAction(actionConfig, deps).execute({});

    if (result.status !== "ok") throw new Error(`expected ok, got ${result.status}`);
    expect(runCalls).toHaveLength(1);
    expect(runCalls[0].prompt).toContain("long-running-web");
  });
});
