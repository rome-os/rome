import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, it, expect } from "@rstest/core";
import type { AppActionRuntimeDeps } from "@rome-os/app-runtime";
import { createTestDb, type TestDb } from "../../../../../packages/core/src/test/helpers.js";
import { createAction } from "./index.js";

const actionConfig = {
  name: "get_webchat_conversations",
  type: "custom",
  description: "Fetch recent webchat conversations",
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

describe("get_webchat_conversations", () => {
  it("returns formatted conversations grouped by session", async () => {
    const rows = [
      {
        session_id: "s1",
        session_name: "Chat A",
        role: "user",
        content: "hello",
        created_at: 1700000000,
      },
      {
        session_id: "s1",
        session_name: "Chat A",
        role: "assistant",
        content: "hi there",
        created_at: 1700000010,
      },
    ];

    const action = createAction(actionConfig, makeDeps(rows));
    const result = await action.execute({ windowHours: 1 });

    if (result.status !== "ok") throw new Error(`expected ok, got ${result.status}`);
    const data = result.data as { messageCount: number; content: string };
    expect(data.messageCount).toBe(2);
    expect(data.content).toContain("### Conversation: Chat A");
    expect(data.content).toContain("**Guardian**: hello");
    expect(data.content).toContain("**Agent**: hi there");
  });

  it("returns empty message when no rows found", async () => {
    const action = createAction(actionConfig, makeDeps([]));
    const result = await action.execute({});

    if (result.status !== "ok") throw new Error(`expected ok, got ${result.status}`);
    const data = result.data as { content: string };
    expect(data.content).toContain("(No webchat conversations found in the requested window.)");
  });

  it("extracts text from JSON content blocks", async () => {
    const rows = [
      {
        session_id: "s1",
        session_name: "Chat",
        role: "assistant",
        content: JSON.stringify([
          { type: "text", text: "Here is the answer" },
          { type: "tool_use", id: "t1", name: "search", input: {} },
        ]),
        created_at: 1700000000,
      },
    ];

    const action = createAction(actionConfig, makeDeps(rows));
    const result = await action.execute({ windowHours: 1 });

    if (result.status !== "ok") throw new Error(`expected ok, got ${result.status}`);
    const data = result.data as { content: string };
    expect(data.content).toContain("Here is the answer");
    expect(data.content).not.toContain("tool_use");
  });

  it("extracts plain string JSON content", async () => {
    const rows = [
      {
        session_id: "s1",
        session_name: "Chat",
        role: "user",
        content: JSON.stringify("a plain string"),
        created_at: 1700000000,
      },
    ];

    const action = createAction(actionConfig, makeDeps(rows));
    const result = await action.execute({ windowHours: 1 });

    if (result.status !== "ok") throw new Error(`expected ok, got ${result.status}`);
    const data = result.data as { content: string };
    expect(data.content).toContain("a plain string");
  });

  it("handles non-JSON raw content gracefully", async () => {
    const rows = [
      {
        session_id: "s1",
        session_name: "Chat",
        role: "user",
        content: "just plain text",
        created_at: 1700000000,
      },
    ];

    const action = createAction(actionConfig, makeDeps(rows));
    const result = await action.execute({ windowHours: 1 });

    if (result.status !== "ok") throw new Error(`expected ok, got ${result.status}`);
    const data = result.data as { content: string };
    expect(data.content).toContain("just plain text");
  });

  it("filters tool_result blocks from content", async () => {
    const rows = [
      {
        session_id: "s1",
        session_name: "Chat",
        role: "assistant",
        content: JSON.stringify([
          { type: "tool_result", content: "internal stuff" },
          { type: "text", text: "visible answer" },
        ]),
        created_at: 1700000000,
      },
    ];

    const action = createAction(actionConfig, makeDeps(rows));
    const result = await action.execute({ windowHours: 1 });

    if (result.status !== "ok") throw new Error(`expected ok, got ${result.status}`);
    const data = result.data as { content: string };
    expect(data.content).toContain("visible answer");
    expect(data.content).not.toContain("internal stuff");
  });

  it("separates multiple sessions with dividers", async () => {
    const rows = [
      {
        session_id: "s1",
        session_name: "Chat A",
        role: "user",
        content: "msg1",
        created_at: 1700000000,
      },
      {
        session_id: "s2",
        session_name: "Chat B",
        role: "user",
        content: "msg2",
        created_at: 1700000010,
      },
    ];

    const action = createAction(actionConfig, makeDeps(rows));
    const result = await action.execute({ windowHours: 1 });

    if (result.status !== "ok") throw new Error(`expected ok, got ${result.status}`);
    const data = result.data as { content: string };
    expect(data.content).toContain("### Conversation: Chat A");
    expect(data.content).toContain("### Conversation: Chat B");
    expect(data.content).toContain("---");
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

  it("returns no-readable-messages when all content is empty", async () => {
    const rows = [
      {
        session_id: "s1",
        session_name: "Chat",
        role: "assistant",
        content: JSON.stringify([{ type: "tool_use", id: "t1", name: "x", input: {} }]),
        created_at: 1700000000,
      },
    ];

    const action = createAction(actionConfig, makeDeps(rows));
    const result = await action.execute({ windowHours: 1 });

    if (result.status !== "ok") throw new Error(`expected ok, got ${result.status}`);
    const data = result.data as { content: string };
    expect(data.content).toContain("(No readable messages found.)");
  });
});

describe("get_webchat_conversations against the system schema", () => {
  let testDb: TestDb;

  beforeEach(() => {
    testDb = createTestDb();
  });

  afterEach(() => {
    testDb.close();
  });

  function realDeps(): AppActionRuntimeDeps {
    return { appContext: { db: { connection: testDb.db } } } as unknown as AppActionRuntimeDeps;
  }

  function seedSession(id: string, name: string, type: string, createdAt: number): void {
    testDb.db.run(sql`
      INSERT INTO rome_sessions (id, name, type, created_at, activity_at)
      VALUES (${id}, ${name}, ${type}, ${createdAt}, ${createdAt})
    `);
  }

  function seedMessage(
    id: string,
    sessionId: string,
    role: string,
    content: string,
    createdAt: number,
  ): void {
    testDb.db.run(sql`
      INSERT INTO rome_agent_messages (id, session_id, role, content, created_at)
      VALUES (${id}, ${sessionId}, ${role}, ${content}, ${createdAt})
    `);
  }

  const text = (value: string) => JSON.stringify([{ type: "text", text: value }]);

  it("reads guardian conversations and skips background runs, traces and notifications", async () => {
    const now = Math.floor(Date.now() / 1000);
    seedSession("web", "Web chat", "webchat", now - 60);
    seedSession("tg", "Telegram chat", "channel", now - 60);
    seedSession("bg", "Dream run", "action", now - 60);
    seedMessage("m1", "web", "user", text("web question"), now - 50);
    seedMessage("m2", "web", "trace", "[]", now - 45);
    seedMessage("m3", "web", "notification", text("ping"), now - 44);
    seedMessage("m4", "web", "assistant", text("web answer"), now - 40);
    seedMessage("m5", "tg", "user", text("channel question"), now - 30);
    seedMessage("m6", "bg", "user", text("dream prompt"), now - 20);

    const result = await createAction(actionConfig, realDeps()).execute({ windowHours: 1 });

    if (result.status !== "ok") throw new Error(`expected ok, got ${result.status}`);
    const data = result.data as { messageCount: number; content: string };
    expect(data.messageCount).toBe(3);
    expect(data.content).toContain("### Conversation: Web chat");
    expect(data.content).toContain("**Guardian**: web question");
    expect(data.content).toContain("**Agent**: web answer");
    expect(data.content).toContain("### Conversation: Telegram chat");
    expect(data.content).not.toContain("ping");
    expect(data.content).not.toContain("dream prompt");
  });

  it("scopes to one session", async () => {
    const now = Math.floor(Date.now() / 1000);
    seedSession("a", "Chat A", "webchat", now - 60);
    seedSession("b", "Chat B", "webchat", now - 60);
    seedMessage("m1", "a", "user", text("from a"), now - 50);
    seedMessage("m2", "b", "user", text("from b"), now - 50);

    const result = await createAction(actionConfig, realDeps()).execute({ sessionId: "a" });

    if (result.status !== "ok") throw new Error(`expected ok, got ${result.status}`);
    const data = result.data as { content: string };
    expect(data.content).toContain("from a");
    expect(data.content).not.toContain("from b");
  });
});
