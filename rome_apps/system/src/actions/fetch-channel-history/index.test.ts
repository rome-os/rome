import { describe, it, expect, rs } from "@rstest/core";
import type { Attachment, ConversationId, InboundMessage, TalkRouter } from "@rome-os/app-runtime";
import { createAction } from "./index.js";

const actionConfig = {
  name: "fetch_channel_history",
  type: "custom",
  description: "Fetch channel message history",
  complexity: "simple",
  speed: "fast",
  reliability: "high",
  sideEffects: "read-only",
} as const;

function makeMessage(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    messageId: "msg1",
    conversationId: "general" as ConversationId,
    senderId: "user1",
    senderDisplayName: "Alice",
    thread: { kind: "group", name: "general" },
    timestamp: new Date("2026-04-15T10:00:00Z"),
    text: "hello world",
    attachments: [],
    ...overrides,
  };
}

interface HistoryAdapter {
  fetchHistory?: (conversationId: string | null, windowHours: number) => Promise<InboundMessage[]>;
}

function makeDeps(adapters: Map<string, HistoryAdapter>): { talkRouter: TalkRouter } {
  return {
    talkRouter: {
      list: async () =>
        [...adapters.keys()].map((service) => ({ connectionId: `test:${service}`, service })),
      subscribe: () => () => {},
      async send(_connectionId, conversationId) {
        return { conversationId };
      },
      feature(connectionId, name) {
        if (name !== "history") return null;
        const adapter = adapters.get(connectionId.slice("test:".length));
        if (!adapter?.fetchHistory) return null;
        return {
          query: ({ conversationId, since }) => {
            const hours = since
              ? Math.max(1, Math.ceil((Date.now() - since.getTime()) / 3_600_000))
              : 24;
            return adapter.fetchHistory?.(conversationId ?? null, hours) ?? Promise.resolve([]);
          },
        } as never;
      },
    },
  };
}

describe("fetch_channel_history", () => {
  it("returns formatted messages on success", async () => {
    const messages = [makeMessage()];
    const adapter: HistoryAdapter = {
      fetchHistory: rs.fn().mockResolvedValue(messages),
    };
    const deps = makeDeps(new Map([["discord", adapter]]));

    const action = createAction(actionConfig, deps);
    const result = await action.execute({ channel: "discord" });

    if (result.status !== "ok") throw new Error(`expected ok, got ${result.status}`);
    const data = result.data as {
      messageCount: number;
      content: string;
    };
    expect(data.messageCount).toBe(1);
    expect(data.content).toContain("Alice");
    expect(data.content).toContain("hello world");
  });

  it("returns error when channel not configured", async () => {
    const deps = makeDeps(new Map());

    const action = createAction(actionConfig, deps);
    const result = await action.execute({ channel: "slack" });

    if (result.status !== "error") throw new Error(`expected error, got ${result.status}`);
    expect(result.error).toContain("not configured");
  });

  it("returns error when adapter has no fetchHistory", async () => {
    const adapter: HistoryAdapter = {};
    const deps = makeDeps(new Map([["telegram", adapter]]));

    const action = createAction(actionConfig, deps);
    const result = await action.execute({ channel: "telegram" });

    if (result.status !== "error") throw new Error(`expected error, got ${result.status}`);
    expect(result.error).toContain("does not support history fetching");
  });

  it("returns error when fetchHistory throws", async () => {
    const adapter: HistoryAdapter = {
      fetchHistory: rs.fn().mockRejectedValue(new Error("API rate limit")),
    };
    const deps = makeDeps(new Map([["discord", adapter]]));

    const action = createAction(actionConfig, deps);
    const result = await action.execute({ channel: "discord" });

    if (result.status !== "error") throw new Error(`expected error, got ${result.status}`);
    expect(result.error).toContain("API rate limit");
  });

  it("returns no-messages text when history is empty", async () => {
    const adapter: HistoryAdapter = {
      fetchHistory: rs.fn().mockResolvedValue([]),
    };
    const deps = makeDeps(new Map([["discord", adapter]]));

    const action = createAction(actionConfig, deps);
    const result = await action.execute({ channel: "discord" });

    if (result.status !== "ok") throw new Error(`expected ok, got ${result.status}`);
    const data = result.data as { content: string };
    expect(data.content).toContain("(No messages found in the requested window.)");
  });

  it("includes attachment info in formatted output", async () => {
    const messages = [
      makeMessage({
        text: "check this",
        attachments: [{ type: "image", fileName: "photo.png" }] as Attachment[],
      }),
    ];
    const adapter: HistoryAdapter = {
      fetchHistory: rs.fn().mockResolvedValue(messages),
    };
    const deps = makeDeps(new Map([["discord", adapter]]));

    const action = createAction(actionConfig, deps);
    const result = await action.execute({ channel: "discord" });

    if (result.status !== "ok") throw new Error(`expected ok, got ${result.status}`);
    const data = result.data as { content: string };
    expect(data.content).toContain("photo.png");
  });

  it("does not include a structured messages array by default", async () => {
    const adapter: HistoryAdapter = {
      fetchHistory: rs.fn().mockResolvedValue([makeMessage()]),
    };
    const deps = makeDeps(new Map([["discord", adapter]]));

    const action = createAction(actionConfig, deps);
    const result = await action.execute({ channel: "discord" });

    if (result.status !== "ok") throw new Error(`expected ok, got ${result.status}`);
    const data = result.data as Record<string, unknown>;
    // Default payload shape must stay exactly as existing consumers expect.
    expect(data.messages).toBeUndefined();
    expect(Object.keys(data).sort()).toEqual(["channel", "content", "messageCount", "windowHours"]);
  });

  it("returns structured messages with attachment metadata when includeMessages is true", async () => {
    const messages = [
      makeMessage({
        text: "see attached",
        attachments: [
          {
            type: "document",
            url: "https://cdn.discordapp.com/attachments/1/2/notes.txt",
            fileName: "notes.txt",
            mimeType: "text/plain",
          },
        ] as Attachment[],
      }),
    ];
    const adapter: HistoryAdapter = {
      fetchHistory: rs.fn().mockResolvedValue(messages),
    };
    const deps = makeDeps(new Map([["discord", adapter]]));

    const action = createAction(actionConfig, deps);
    const result = await action.execute({ channel: "discord", includeMessages: true });

    if (result.status !== "ok") throw new Error(`expected ok, got ${result.status}`);
    const data = result.data as {
      content: string;
      messages: Array<{
        id: string;
        displayName: string;
        timestamp: string;
        text: string;
        attachments: Array<{ type: string; url?: string; fileName?: string; mimeType?: string }>;
      }>;
    };
    // The markdown content is still produced unchanged.
    expect(data.content).toContain("see attached");
    // ...and the structured array exposes the full per-message shape.
    expect(Array.isArray(data.messages)).toBe(true);
    expect(data.messages).toHaveLength(1);
    expect(data.messages[0]).toMatchObject({
      id: "msg1",
      displayName: "Alice",
      timestamp: "2026-04-15T10:00:00.000Z",
      text: "see attached",
    });
    expect(data.messages[0].attachments[0]).toMatchObject({
      type: "document",
      url: "https://cdn.discordapp.com/attachments/1/2/notes.txt",
      fileName: "notes.txt",
      mimeType: "text/plain",
    });
    // localPath is intentionally excluded from the structured payload.
    expect("localPath" in data.messages[0].attachments[0]).toBe(false);
  });
});
