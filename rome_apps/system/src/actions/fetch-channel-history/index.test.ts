import { describe, it, expect, rs } from "@rstest/core";
import type { Attachment, ChannelMessage, ChannelsService, ChatId } from "@rome-os/app-runtime";
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

function makeMessage(overrides: Partial<ChannelMessage> = {}): ChannelMessage {
  return {
    channel: "discord",
    direction: "inbound",
    messageId: "msg1",
    chatId: "general" as ChatId,
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
  readHistory?: (chatId: string | null, windowHours: number) => Promise<ChannelMessage[]>;
}

function makeDeps(adapters: Map<string, HistoryAdapter>): { channelsService: ChannelsService } {
  return {
    channelsService: {
      list: async () => [...adapters.keys()].map((name) => ({ name, sendable: true })),
      async send(_channel, chatId) {
        return { chatId };
      },
      async query(channel, { chatId, since } = {}) {
        const adapter = adapters.get(channel);
        // What the channels service says of a channel that reads no messages.
        if (!adapter?.readHistory) throw new Error(`Channel "${channel}" reads no messages`);
        const hours = since
          ? Math.max(1, Math.ceil((Date.now() - since.getTime()) / 3_600_000))
          : 24;
        // An adapter answers oldest first, and `query` newest first.
        return [...(await adapter.readHistory(chatId ?? null, hours))].reverse();
      },
    },
  };
}

describe("fetch_channel_history", () => {
  it("returns formatted messages on success", async () => {
    const messages = [makeMessage()];
    const adapter: HistoryAdapter = {
      readHistory: rs.fn().mockResolvedValue(messages),
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

  it("names each message of a chat that keeps chat threads, and the root of its thread when that is another message", async () => {
    const messages = [
      makeMessage({ messageId: "m1", text: "Weather?", chatThread: "m1" }),
      makeMessage({ messageId: "m2", text: "Sunny", chatThread: "m1" }),
      makeMessage({ messageId: "m3", text: "No threads here" }),
    ];
    const deps = makeDeps(
      new Map([["discord", { readHistory: rs.fn().mockResolvedValue(messages) }]]),
    );

    const result = await createAction(actionConfig, deps).execute({ channel: "discord" });

    if (result.status !== "ok") throw new Error(`expected ok, got ${result.status}`);
    const { content } = result.data as { content: string };
    expect(content).toContain("(message m1): Weather?");
    expect(content).toContain("(message m2, chat thread m1): Sunny");
    expect(content).not.toContain("(message m3");
  });

  it("returns error when channel not configured", async () => {
    const deps = makeDeps(new Map());

    const action = createAction(actionConfig, deps);
    const result = await action.execute({ channel: "slack" });

    if (result.status !== "error") throw new Error(`expected error, got ${result.status}`);
    expect(result.error).toBe('Channel "slack" is not configured or not running.');
  });

  it("lists the newest-first page `query` answers oldest first", async () => {
    const deps = makeDeps(new Map([["discord", {}]]));
    deps.channelsService.query = async () => [
      makeMessage({ messageId: "m2", text: "second", timestamp: new Date("2026-04-15T11:00:00Z") }),
      makeMessage({ messageId: "m1", text: "first", timestamp: new Date("2026-04-15T10:00:00Z") }),
    ];

    const action = createAction(actionConfig, deps);
    const result = await action.execute({ channel: "discord", includeMessages: true });

    if (result.status !== "ok") throw new Error(`expected ok, got ${result.status}`);
    const data = result.data as { content: string; messages: Array<{ id: string }> };
    expect(data.messages.map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(data.content.indexOf("first")).toBeLessThan(data.content.indexOf("second"));
  });

  it("returns error when the channel reads no history", async () => {
    const adapter: HistoryAdapter = {};
    const deps = makeDeps(new Map([["telegram", adapter]]));

    const action = createAction(actionConfig, deps);
    const result = await action.execute({ channel: "telegram" });

    if (result.status !== "error") throw new Error(`expected error, got ${result.status}`);
    expect(result.error).toBe(
      'Failed to fetch history from "telegram": Channel "telegram" reads no messages',
    );
  });

  it("returns error when the read throws", async () => {
    const adapter: HistoryAdapter = {
      readHistory: rs.fn().mockRejectedValue(new Error("API rate limit")),
    };
    const deps = makeDeps(new Map([["discord", adapter]]));

    const action = createAction(actionConfig, deps);
    const result = await action.execute({ channel: "discord" });

    if (result.status !== "error") throw new Error(`expected error, got ${result.status}`);
    expect(result.error).toContain("API rate limit");
  });

  it("returns no-messages text when history is empty", async () => {
    const adapter: HistoryAdapter = {
      readHistory: rs.fn().mockResolvedValue([]),
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
      readHistory: rs.fn().mockResolvedValue(messages),
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
      readHistory: rs.fn().mockResolvedValue([makeMessage()]),
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
      readHistory: rs.fn().mockResolvedValue(messages),
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

  describe("on a platform", () => {
    const account = { platform: "whatsapp", id: "15551234567" };
    function platformDeps(...names: string[]) {
      const query = rs.fn<ChannelsService["query"]>().mockResolvedValue([]);
      const deps = {
        channelsService: {
          list: async () =>
            names.map((name) => ({ name, account, platform: "whatsapp", sendable: true })),
          send: async (_account: unknown, chatId: ChatId) => ({ chatId }),
          query,
        } as ChannelsService,
      };
      return { query, action: createAction(actionConfig, deps) };
    }

    it("reads Rome's one account there, by its platform and id", async () => {
      const { query, action } = platformDeps("6f1d2c3b-0000-4000-8000-000000000001");

      const result = await action.execute({ platform: "whatsapp" });

      expect(result.status).toBe("ok");
      expect(query).toHaveBeenCalledWith(account, expect.anything());
    });

    it("counts only the accounts Rome holds, and reads a disconnected one by its name", async () => {
      const held = { platform: "lark", id: "ou_new" };
      const query = rs.fn<ChannelsService["query"]>().mockResolvedValue([]);
      const action = createAction(actionConfig, {
        channelsService: {
          // The first account was disconnected, and its channel stays behind.
          list: async () => [
            { name: "released", platform: "lark", sendable: false },
            { name: "connected", account: held, platform: "lark", sendable: true },
          ],
          send: async (_account: unknown, chatId: ChatId) => ({ chatId }),
          query,
        } as ChannelsService,
      });

      expect((await action.execute({ platform: "lark" })).status).toBe("ok");
      expect((await action.execute({ channel: "released" })).status).toBe("ok");
      expect(query.mock.calls.map(([account]) => account)).toEqual([held, "released"]);
    });

    it("refuses a platform where Rome has several accounts", async () => {
      const { query, action } = platformDeps("first", "second");

      const result = await action.execute({ platform: "whatsapp" });

      expect(result).toEqual({
        status: "error",
        error: expect.stringContaining('Rome has several accounts on "whatsapp"'),
      });
      expect(query).not.toHaveBeenCalled();
    });
  });

  describe("paging with limit and cursor", () => {
    function pagedDeps(page: ChannelMessage[]) {
      const query = rs.fn<ChannelsService["query"]>().mockResolvedValue(page);
      const deps = {
        channelsService: {
          list: async () => [{ name: "webchat", sendable: true }],
          send: async (_channel: string, chatId: ChatId) => ({ chatId }),
          query,
        } as ChannelsService,
      };
      return { query, action: createAction(actionConfig, deps) };
    }
    const at = (id: string, minute: number, cursor: string) =>
      makeMessage({
        messageId: id,
        text: id,
        timestamp: new Date(Date.UTC(2026, 9, 26, 0, minute)),
        cursor,
      });

    it("asks for a page with no time bound and returns the cursor of its oldest message", async () => {
      const { query, action } = pagedDeps([at("m3", 3, "c3"), at("m2", 2, "c2")]);
      const result = await action.execute({ channel: "webchat", threadId: "chat-1", limit: 2 });

      expect(query).toHaveBeenCalledWith("webchat", {
        chatId: "chat-1",
        since: new Date(0),
        limit: 2,
      });
      const data = (result as { data: { nextCursor: string | null; content: string } }).data;
      expect(data.nextCursor).toBe("c2");
      expect(data.content.indexOf("m2")).toBeLessThan(data.content.indexOf("m3"));
    });

    it("names the default page size when only a cursor is given", async () => {
      const { query, action } = pagedDeps([]);
      await action.execute({ channel: "webchat", threadId: "chat-1", cursor: "c2" });
      expect(query).toHaveBeenCalledWith("webchat", {
        chatId: "chat-1",
        since: new Date(0),
        after: "c2",
        limit: 100,
      });
    });

    it("refuses to page without a threadId", async () => {
      const { query, action } = pagedDeps([]);
      const result = await action.execute({ channel: "webchat", limit: 5 });
      expect(result).toEqual({
        status: "error",
        error: "Paging with limit, cursor, olderThan or newerThan needs a threadId.",
      });
      expect(query).not.toHaveBeenCalled();
    });

    it("resumes after a cursor, and ends with no cursor on an empty page", async () => {
      const { query, action } = pagedDeps([]);
      const result = await action.execute({
        channel: "webchat",
        threadId: "chat-1",
        limit: 2,
        cursor: "c2",
      });

      expect(query).toHaveBeenCalledWith("webchat", {
        chatId: "chat-1",
        since: new Date(0),
        after: "c2",
        limit: 2,
      });
      expect((result as { data: { nextCursor: string | null } }).data.nextCursor).toBeNull();
    });

    it("pages on past a short page that a platform read live cut at 15 messages", async () => {
      // Slack keeps 40 messages, and answers at most 15 at a time.
      const all = Array.from({ length: 40 }, (_, i) => at(`m${40 - i}`, 40 - i, `c${40 - i}`));
      const query = rs.fn<ChannelsService["query"]>(async (_target, read) => {
        const from = read?.after ? all.findIndex((m) => m.cursor === read.after) + 1 : 0;
        return all.slice(from, from + Math.min(read?.limit ?? 100, 15));
      });
      const action = createAction(actionConfig, {
        channelsService: {
          list: async () => [{ name: "slack", sendable: true }],
          send: async (_channel: string, chatId: ChatId) => ({ chatId }),
          query,
        } as ChannelsService,
      });

      const read: string[] = [];
      let cursor: string | undefined;
      for (let call = 0; call < 10; call++) {
        const result = await action.execute({
          channel: "slack",
          threadId: "C1",
          limit: 100,
          ...(cursor ? { cursor } : {}),
          includeMessages: true,
        });
        const data = (result as { data: { nextCursor: string | null; messages: { id: string }[] } })
          .data;
        read.push(...data.messages.map((m) => m.id));
        if (!data.nextCursor) break;
        cursor = data.nextCursor;
      }

      expect(read).toHaveLength(40);
      expect(new Set(read).size).toBe(40);
      // Three pages of 15, 15 and 10, then one empty read that ends paging.
      expect(query).toHaveBeenCalledTimes(4);
    });

    it("names where to read on after a plain read of one chat, which Slack may cut short", async () => {
      const query = rs.fn<ChannelsService["query"]>(async () =>
        Array.from({ length: 15 }, (_, i) => at(`m${40 - i}`, 40 - i, `c${40 - i}`)),
      );
      const action = createAction(actionConfig, {
        channelsService: {
          list: async () => [{ name: "slack", sendable: true }],
          send: async (_channel: string, chatId: ChatId) => ({ chatId }),
          query,
        } as ChannelsService,
      });

      const one = await action.execute({ channel: "slack", threadId: "D1" });
      expect((one as { data: Record<string, unknown> }).data.nextCursor).toBe("c26");

      const every = await action.execute({ channel: "slack" });
      expect((every as { data: Record<string, unknown> }).data).not.toHaveProperty("nextCursor");
    });
  });

  describe("an account read by message id", () => {
    function discordDeps(page: ChannelMessage[]) {
      const query = rs.fn<ChannelsService["query"]>().mockResolvedValue(page);
      const account = { platform: "discord", id: "bot-1" };
      const deps = {
        channelsService: {
          list: async () => [{ name: "discord", account, platform: "discord", sendable: true }],
          send: async (_channel: string, chatId: ChatId) => ({ chatId }),
          query,
        } as ChannelsService,
      };
      return { query, account, action: createAction(actionConfig, deps) };
    }
    const said = (id: string, minute: number, extra: Partial<ChannelMessage> = {}) =>
      makeMessage({
        messageId: id,
        text: id,
        timestamp: new Date(Date.UTC(2026, 10, 19, 8, minute)),
        ...extra,
      });

    it("names each message and the thread it opened", async () => {
      const { action } = discordDeps([
        said("m2", 2, { openedThread: "t1" as ChatId }),
        said("m1", 1),
      ]);

      const result = await action.execute({ platform: "discord", threadId: "general" });

      const content = (result as { data: { content: string } }).data.content;
      expect(content).toContain("**Alice** (message m1): m1");
      expect(content).toContain("**Alice** (message m2, opened thread t1): m2");
    });

    it("reads on from the newest message of a full page read forward", async () => {
      const { query, account, action } = discordDeps([said("m3", 3), said("m2", 2)]);

      const result = await action.execute({
        platform: "discord",
        threadId: "general",
        newerThan: "m1",
        limit: 2,
      });

      expect(query).toHaveBeenCalledWith(account, {
        chatId: "general",
        since: new Date(0),
        newerThan: "m1",
        limit: 2,
      });
      const data = (result as { data: Record<string, unknown> }).data;
      expect(data.nextNewerThan).toBe("m3");
      expect(data).not.toHaveProperty("nextCursor");
    });
  });

  describe("an account read by message id", () => {
    function discordDeps(page: ChannelMessage[]) {
      const query = rs.fn<ChannelsService["query"]>().mockResolvedValue(page);
      const account = { platform: "discord", id: "bot-1" };
      const deps = {
        channelsService: {
          list: async () => [{ name: "discord", account, platform: "discord", sendable: true }],
          send: async (_channel: string, chatId: ChatId) => ({ chatId }),
          query,
        } as ChannelsService,
      };
      return { query, account, action: createAction(actionConfig, deps) };
    }
    const said = (id: string, minute: number, extra: Partial<ChannelMessage> = {}) =>
      makeMessage({
        messageId: id,
        text: id,
        timestamp: new Date(Date.UTC(2026, 10, 19, 8, minute)),
        ...extra,
      });

    it("names each message and the thread it opened", async () => {
      const { action } = discordDeps([
        said("m2", 2, { openedThread: "t1" as ChatId }),
        said("m1", 1),
      ]);

      const result = await action.execute({ platform: "discord", threadId: "general" });

      const content = (result as { data: { content: string } }).data.content;
      expect(content).toContain("**Alice** (message m1): m1");
      expect(content).toContain("**Alice** (message m2, opened thread t1): m2");
    });

    it("reads on from the newest message of a full page read forward", async () => {
      const { query, account, action } = discordDeps([said("m3", 3), said("m2", 2)]);

      const result = await action.execute({
        platform: "discord",
        threadId: "general",
        newerThan: "m1",
        limit: 2,
      });

      expect(query).toHaveBeenCalledWith(account, {
        chatId: "general",
        since: new Date(0),
        newerThan: "m1",
        limit: 2,
      });
      const data = (result as { data: Record<string, unknown> }).data;
      expect(data.nextNewerThan).toBe("m3");
      expect(data).not.toHaveProperty("nextCursor");
    });
  });
});
