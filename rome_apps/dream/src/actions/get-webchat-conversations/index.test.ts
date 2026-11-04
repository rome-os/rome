import { describe, it, expect } from "@rstest/core";
import type { AppActionRuntimeDeps } from "@rome-os/app-runtime";
import { type FakeChat, fakeChatReads, withChatReads } from "../../test-support/fake-chat-reads.js";
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

// Ten minutes ago, inside every window the tests ask for.
const T0 = Math.floor(Date.now() / 1000) - 600;

interface Row {
  session_id: string;
  session_name: string;
  role: string;
  content: string;
  created_at: number;
}

/** A host whose dashboard chats hold `rows`, grouped by session. */
function makeDeps(rows: Row[]): AppActionRuntimeDeps {
  const chats = new Map<string, FakeChat>();
  for (const row of rows) {
    const chat = chats.get(row.session_id) ?? {
      chat: { sessionId: row.session_id, name: row.session_name },
      lines: [],
    };
    chat.lines.push({
      role: row.role as FakeChat["lines"][number]["role"],
      content: row.content,
      createdAt: new Date(row.created_at * 1000),
    });
    chats.set(row.session_id, chat);
  }
  const reads = fakeChatReads([...chats.values()]);
  return { appContext: withChatReads(reads) } as unknown as AppActionRuntimeDeps;
}

describe("get_webchat_conversations", () => {
  it("returns formatted conversations grouped by session", async () => {
    const rows = [
      {
        session_id: "s1",
        session_name: "Chat A",
        role: "user",
        content: "hello",
        created_at: T0,
      },
      {
        session_id: "s1",
        session_name: "Chat A",
        role: "assistant",
        content: "hi there",
        created_at: T0 + 10,
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
        created_at: T0,
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
        created_at: T0,
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
        created_at: T0,
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
        created_at: T0,
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
        created_at: T0,
      },
      {
        session_id: "s2",
        session_name: "Chat B",
        role: "user",
        content: "msg2",
        created_at: T0 + 10,
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

  it("returns error when reading chats fails", async () => {
    const reads = fakeChatReads([]);
    reads.recentChats = async () => {
      throw new Error("db locked");
    };
    const deps = { appContext: withChatReads(reads) } as unknown as AppActionRuntimeDeps;

    const action = createAction(actionConfig, deps);
    const result = await action.execute({});

    if (result.status !== "error") throw new Error(`expected error, got ${result.status}`);
    expect(result.error).toContain("db locked");
  });

  it("returns error when the host offers no chat reads", async () => {
    const deps = { appContext: {} } as unknown as AppActionRuntimeDeps;

    const result = await createAction(actionConfig, deps).execute({});

    if (result.status !== "error") throw new Error(`expected error, got ${result.status}`);
    expect(result.error).toContain("no chat reads");
  });

  it("scopes to one session", async () => {
    const deps = makeDeps([
      { session_id: "a", session_name: "Chat A", role: "user", content: "from a", created_at: T0 },
      { session_id: "b", session_name: "Chat B", role: "user", content: "from b", created_at: T0 },
    ]);

    const result = await createAction(actionConfig, deps).execute({ sessionId: "a" });

    if (result.status !== "ok") throw new Error(`expected ok, got ${result.status}`);
    const data = result.data as { content: string };
    expect(data.content).toContain("from a");
    expect(data.content).not.toContain("from b");
  });

  it("returns no-readable-messages when all content is empty", async () => {
    const rows = [
      {
        session_id: "s1",
        session_name: "Chat",
        role: "assistant",
        content: JSON.stringify([{ type: "tool_use", id: "t1", name: "x", input: {} }]),
        created_at: T0,
      },
    ];

    const action = createAction(actionConfig, makeDeps(rows));
    const result = await action.execute({ windowHours: 1 });

    if (result.status !== "ok") throw new Error(`expected ok, got ${result.status}`);
    const data = result.data as { content: string };
    expect(data.content).toContain("(No readable messages found.)");
  });
});

describe("get_webchat_conversations through Chats", () => {
  it("reads the guardian's dashboard chats, leaving out a visitor's and Rome's notes", async () => {
    const now = new Date();
    const reads = fakeChatReads([
      {
        chat: { sessionId: "s1", name: "Plans" },
        lines: [
          { role: "user", content: "hello", createdAt: now },
          { role: "notification", content: "fyi", createdAt: now },
          { role: "assistant", content: "hi there", createdAt: now },
        ],
      },
      {
        chat: { sessionId: "s2", name: "Visitor" },
        lines: [{ role: "user", content: "secret", createdAt: now, senderId: "visitor:v1" }],
      },
    ]);
    const deps = { appContext: withChatReads(reads) } as unknown as AppActionRuntimeDeps;

    const result = await createAction(actionConfig, deps).execute({ windowHours: 1 });

    if (result.status !== "ok") throw new Error(`expected ok, got ${result.status}`);
    const data = result.data as { messageCount: number; content: string };
    expect(data.messageCount).toBe(2);
    expect(data.content).toContain("### Conversation: Plans");
    expect(data.content).toContain("**Guardian**: hello");
    expect(data.content).toContain("**Agent**: hi there");
    expect(data.content).not.toContain("secret");
  });
});
