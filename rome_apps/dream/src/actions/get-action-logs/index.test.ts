import { sql } from "drizzle-orm";
import { createTestDb, type TestDb } from "../../../../../packages/core/src/test/helpers.js";
import { afterEach, beforeEach, describe, it, expect } from "@rstest/core";
import type { AppActionRuntimeDeps } from "@rome-os/app-runtime";
import { createAction } from "./index.js";

const actionConfig = {
  name: "get_action_logs",
  type: "custom",
  description: "Fetch recent action execution logs",
  complexity: "simple",
  speed: "fast",
  reliability: "high",
  sideEffects: "read-only",
} as const;

function makeDeps(rows: unknown[]): AppActionRuntimeDeps {
  return {
    appContext: {
      db: {
        connection: {
          all: () => rows,
        },
      },
    },
  } as unknown as AppActionRuntimeDeps;
}

describe("get_action_logs", () => {
  it("returns formatted logs grouped by action name", async () => {
    const rows = [
      {
        id: "1",
        action_name: "send_message",
        action_type: "system",
        status: "success",
        args: null,
        error: null,
        duration_ms: 100,
        initiator: "main",
        started_at: Math.floor(Date.now() / 1000) - 60,
        finished_at: Math.floor(Date.now() / 1000),
      },
      {
        id: "2",
        action_name: "send_message",
        action_type: "system",
        status: "error",
        args: null,
        error: "timeout",
        duration_ms: 5000,
        initiator: "main",
        started_at: Math.floor(Date.now() / 1000) - 30,
        finished_at: null,
      },
    ];

    const action = createAction(actionConfig, makeDeps(rows));
    const result = await action.execute({ windowHours: 1 });

    if (result.status !== "ok") throw new Error(`expected ok, got ${result.status}`);
    const data = result.data as {
      executionCount: number;
      content: string;
    };
    expect(data.executionCount).toBe(2);
    expect(data.content).toContain("send_message");
    expect(data.content).toContain("1 succeeded");
    expect(data.content).toContain("1 failed");
    expect(data.content).toContain("timeout");
  });

  it("returns empty message when no rows", async () => {
    const action = createAction(actionConfig, makeDeps([]));
    const result = await action.execute({});

    if (result.status !== "ok") throw new Error(`expected ok, got ${result.status}`);
    const data = result.data as { content: string };
    expect(data.content).toContain("(No action executions found in the requested window.)");
  });

  it("returns error when DB query fails", async () => {
    const deps = {
      appContext: {
        db: {
          connection: {
            all: () => {
              throw new Error("db locked");
            },
          },
        },
      },
    } as unknown as AppActionRuntimeDeps;

    const action = createAction(actionConfig, deps);
    const result = await action.execute({});

    if (result.status !== "error") throw new Error(`expected error, got ${result.status}`);
    expect(result.error).toContain("db locked");
  });

  it("defaults windowHours to 24", async () => {
    const action = createAction(actionConfig, makeDeps([]));
    const result = await action.execute({});

    if (result.status !== "ok") throw new Error(`expected ok, got ${result.status}`);
    const data = result.data as { windowHours: number };
    expect(data.windowHours).toBe(24);
  });
});

describe("get_action_logs isolation against the system schema", () => {
  let db: TestDb;
  beforeEach(() => {
    db = createTestDb();
  });
  afterEach(() => db.close());

  function session(id: string, metadata = "{}", parent: string | null = null) {
    db.db.run(sql`INSERT INTO rome_sessions (id, name, metadata_json, parent_session_id, created_at, activity_at)
      VALUES (${id}, ${id}, ${metadata}, ${parent}, 0, 0)`);
  }

  function execution(
    id: string,
    name: string,
    sessionId: string | null = null,
    root = id,
    args = "{}",
  ) {
    const now = Math.floor(Date.now() / 1000);
    db.db.run(sql`INSERT INTO action_executions (id, root_execution_id, action_name, status, session_id, args, started_at, created_at)
      VALUES (${id}, ${root}, ${name}, 'error', ${sessionId}, ${args}, ${now}, ${now})`);
  }

  async function read(input: Record<string, unknown> = {}) {
    const deps = { appContext: { db: { connection: db.db } } } as unknown as AppActionRuntimeDeps;
    const result = await createAction(actionConfig, deps).execute(input);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error(JSON.stringify(result));
    return result.data as { content: string; executionCount: number };
  }

  it("excludes session/root/ancestor provenance and dispatches before formatting private arguments", async () => {
    session("isolated", '{"isolated":true,"appId":"navi-bench"}');
    session("normal");
    session("child", "{}", "isolated");
    session("grandchild", "{}", "child");
    execution("private-direct", "other:direct", "isolated");
    execution("private-root-child", "other:nested", null, "private-direct");
    execution("private-ancestor", "other:ancestor", "grandchild");
    execution(
      "private-send",
      "system:send_user_message",
      null,
      undefined,
      '{"sessionMetadata":{"isolated":true},"text":"SECRET-TASK"}',
    );
    execution(
      "private-continue",
      "system:send_user_message",
      "normal",
      undefined,
      '{"sessionId":"isolated","text":"SECRET-CONTINUATION"}',
    );
    execution("private-parent-only", "other:parent", "isolated", "missing-root");
    execution("private-parent-child", "other:parent-child", null, "missing-root");
    db.db.run(
      sql`UPDATE action_executions SET parent_id = 'private-parent-only' WHERE id = 'private-parent-child'`,
    );
    execution("normal-action", "notes:normal", "normal");
    execution(
      "normal-send",
      "system:send_user_message",
      "normal",
      undefined,
      '{"text":"normal task"}',
    );
    const data = await read();
    expect(data.executionCount).toBe(2);
    expect(data.content).toContain("notes:normal");
    expect(data.content).not.toContain("SECRET");
    expect((await read({ actionName: "other:direct" })).executionCount).toBe(0);
    expect((await read({ actionName: "system:send_user_message" })).executionCount).toBe(1);
  });

  it("uses an exact app prefix only when no session or root provenance exists", async () => {
    session("isolated", '{"isolated":true,"appId":"navi-bench"}');
    session("normal");
    execution("fallback", "navi-bench:run");
    execution("dangling", "navi-bench:run", "deleted-session");
    execution("attributed-normal", "navi-bench:run", "normal");
    execution("normal-root-child", "navi-bench:child", null, "attributed-normal");
    execution("similar-app", "navi-bench-extra:run");
    execution("unknown", "unknown:run");
    session("scoped-isolated", '{"isolated":true,"appId":"@alice/navi_bench"}');
    execution("scoped-fallback", "@alice/navi_bench:run");
    execution("scoped-similar", "@alice/naviXbench:run");
    const data = await read();
    expect(data.executionCount).toBe(5);
    expect((await read({ actionName: "navi-bench:run" })).executionCount).toBe(1);
    expect(data.content).toContain("unknown:run");
    expect(data.content).toContain("navi-bench-extra:run");
  });

  it("tolerates malformed/legacy metadata and arguments and terminates cyclic ancestry", async () => {
    session("legacy", "{broken");
    session("numeric", '{"isolated":1}');
    session("null", "null");
    session("cycle-a", "{}", "cycle-b");
    session("cycle-b", "{}", "cycle-a");
    execution("legacy-action", "notes:run", "legacy");
    execution("numeric-action", "notes:run", "numeric");
    execution("null-action", "notes:run", "null");
    execution("cycle-action", "notes:run", "cycle-a");
    execution("malformed-send", "system:send_user_message", null, undefined, "{broken");
    expect((await read()).executionCount).toBe(5);
  });
});
