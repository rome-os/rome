import { describe, it, expect } from "@rstest/core";
import type { AppActionRuntimeDeps } from "@rome-os/app-runtime";
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
