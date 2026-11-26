import { describe, it, expect, rs } from "@rstest/core";
import { chatWorkerCalls, type ChatWorkerCallsDeps } from "./chat-calls.js";
import { createChannelsService } from "./accounts-service.js";
import { conciergeChatGuard } from "../concierge/automated-input.js";
import { createTestDb } from "../test/db.js";
import { ChatsWebChatRepository } from "../webchat/chats-webchat-repository.js";
import { webchatChannel } from "../webchat/dashboard-account.js";
import { isConciergeChat, TASK_CHAT_TRIGGER_KIND } from "../webchat/privacy.js";

function makeCalls(overrides: Partial<ChatWorkerCallsDeps> = {}) {
  return chatWorkerCalls({
    channelsService: { list: rs.fn(), send: rs.fn(), query: rs.fn() } as never,
    chatSettings: { list: rs.fn(), get: rs.fn(), update: rs.fn(), reset: rs.fn() } as never,
    agentNames: { resolve: rs.fn() } as never,
    ...overrides,
  });
}

describe("chatSettings.get", () => {
  it("reads the settings of the chat the ref names", async () => {
    const get = rs.fn(async () => ({ agentName: "main" }));
    const calls = makeCalls({
      chatSettings: { list: rs.fn(), get, update: rs.fn(), reset: rs.fn() } as never,
    });
    const ref = { connectionId: "conn-1", chatId: "c1" };

    expect(await calls["chatSettings.get"]({ ref })).toEqual({ agentName: "main" });
    expect(get).toHaveBeenCalledWith(ref);
  });

  it("rejects a ref with no connection", async () => {
    const calls = makeCalls();

    await expect(calls["chatSettings.get"]({ ref: { chatId: "c1" } })).rejects.toThrow(
      "chatSettings.get: invalid params",
    );
  });
});

describe("channels.send", () => {
  it("sends as the person of the calling action's dashboard chat", async () => {
    const send = rs.fn(async () => ({ messageId: "m1" }));
    const calls = makeCalls({
      channelsService: { list: rs.fn(), send, query: rs.fn() } as never,
    });

    await calls["channels.send"](
      { channel: "webchat", chatId: "c1", message: { text: "hi" } },
      {
        callerActionContext: {
          actor: { kind: "guardian", userId: "guardian", via: "cookie" },
          channelContext: { channel: "webchat", threadId: "t1" },
        },
      },
    );

    expect(send).toHaveBeenCalledWith("webchat", "c1", { text: "hi" });
  });
});

describe("channels.send into a Concierge chat", () => {
  const setup = async () => {
    const testDb = createTestDb();
    const repo = new ChatsWebChatRepository(testDb.db);
    await repo.createSession(
      "concierge",
      "Main chat",
      undefined,
      undefined,
      null,
      null,
      "core:concierge",
    );
    await repo.createSession("plain", "Plans");
    // The guardian's task chat, where the main agent sends from.
    await repo.createSession("task-1", "Flights");
    await repo.setSessionTrigger("task-1", {
      triggerKind: TASK_CHAT_TRIGGER_KIND,
      triggerName: null,
    });
    const runSystemTurn = rs.fn(async () => true);
    const channelsService = createChannelsService({
      channels: () => [],
      own: [webchatChannel(repo)],
      registry: { list: () => [], find: () => [] } as never,
      channelOf: () => null,
    });
    const calls = chatWorkerCalls({
      channelsService,
      chatSettings: {} as never,
      agentNames: {} as never,
      intoConciergeChat: conciergeChatGuard({
        isConciergeChat: async (chatId) => isConciergeChat(await repo.getSession(chatId)),
        senderOf: async (agentName) => ({
          sourceType: agentName ? "agent" : null,
          name: agentName === "core:main" ? "Milo" : null,
        }),
        runSystemTurn,
      }),
    });
    // A task chat's main agent calling system:send_message.
    const send = (chatId: string, agentName = "core:main") =>
      calls["channels.send"](
        { channel: "webchat", chatId, message: { text: "Here is the full report." } },
        {
          callerActionContext: {
            // The Concierge sends from its own chat, the main agent from a task chat.
            channelContext: {
              channel: "webchat",
              threadId: agentName === "core:concierge" ? "concierge" : "task-1",
            },
            agentName,
          },
        },
      );
    return { testDb, repo, runSystemTurn, send, calls };
  };

  it("wakes the Concierge with a send from anyone's turn", async () => {
    const { testDb, repo, runSystemTurn, calls } = await setup();
    const sendAs = (callerActionContext: Record<string, unknown>) =>
      calls["channels.send"](
        { channel: "webchat", chatId: "concierge", message: { text: "Wire the money." } },
        { callerActionContext },
      );
    try {
      // A member's agent, and an app action no person ran from a common chat.
      const context = {
        channelContext: { channel: "webchat", threadId: "plain" },
        agentName: "core:main",
      };
      await sendAs({ ...context, actor: { kind: "visitor", userId: "v1", via: "cookie" } });
      await sendAs(context);
      expect(runSystemTurn).toHaveBeenCalledTimes(2);
      expect(await repo.getMessages("concierge")).toEqual([]);
    } finally {
      testDb.close();
    }
  });

  it("wakes the Concierge with a task chat's send, and writes no line for it", async () => {
    const { testDb, repo, runSystemTurn, send } = await setup();
    try {
      expect(await send("concierge")).toEqual({ chatId: "concierge" });
      expect(await repo.getMessages("concierge")).toEqual([]);
      expect(runSystemTurn).toHaveBeenCalledWith(
        "concierge",
        '<automated_input source="agent" name="Milo">\nHere is the full report.\n</automated_input>',
        {
          quiet: true,
          inputLabel: "Agent · Milo",
          inputSource: { type: "agent", name: "Milo" },
          pushLevel: "active",
        },
      );
    } finally {
      testDb.close();
    }
  });

  it("refuses a send with a file or a card, as an empty one, rather than drop it", async () => {
    const { testDb, runSystemTurn, calls } = await setup();
    const sendWith = (message: Record<string, unknown>) =>
      calls["channels.send"](
        { channel: "webchat", chatId: "concierge", message },
        {
          callerActionContext: {
            channelContext: { channel: "webchat", threadId: "task-1" },
            agentName: "core:main",
          },
        },
      );
    try {
      await expect(
        sendWith({
          text: "Here is the report.",
          attachments: [{ path: "/tmp/report.pdf", name: "report.pdf" }],
        }),
      ).rejects.toThrow("A Concierge chat takes only text");
      await expect(
        sendWith({
          parts: [
            { type: "text", content: "Here is the report." },
            { type: "image", url: "https://example.com/chart.png" },
          ],
        }),
      ).rejects.toThrow("A Concierge chat takes only text");
      expect(runSystemTurn).not.toHaveBeenCalled();
    } finally {
      testDb.close();
    }
  });

  it("leaves a common chat's send, and the Concierge's own, a line in the chat", async () => {
    const { testDb, repo, runSystemTurn, send } = await setup();
    try {
      await send("plain");
      await send("concierge", "core:concierge");
      expect(runSystemTurn).not.toHaveBeenCalled();
      expect((await repo.getMessages("plain")).map((row) => row.role)).toEqual(["assistant"]);
      expect((await repo.getMessages("concierge")).map((row) => row.role)).toEqual(["assistant"]);
    } finally {
      testDb.close();
    }
  });
});

describe("channels.query", () => {
  it("reads any chat from any turn, such as a member's in a group", async () => {
    const query = rs.fn(async () => []);
    const calls = makeCalls({
      channelsService: { list: rs.fn(), send: rs.fn(), query } as never,
    });
    const turn = {
      callerActionContext: {
        actor: { kind: "visitor", accountId: "member", email: "m@example.test" },
        channelContext: { channel: "telegram", threadId: "chat-a", threadType: "group" as const },
      },
    } as never;

    await calls["channels.query"]({ channel: "telegram", chatId: "chat-b" }, turn);
    await calls["channels.query"]({ channel: "whatsapp", chatId: "chat-a" }, turn);
    await calls["channels.query"]({ channel: "telegram" }, turn);

    expect(query).toHaveBeenCalledTimes(3);
    expect(query).toHaveBeenCalledWith("telegram", { chatId: "chat-b" });
  });
});

describe("channels.chats", () => {
  const turnIn = {
    callerActionContext: {
      channelContext: { channel: "slack_app", threadId: "C1", threadType: "group" as const },
    },
  };

  it("lists an account's chats from a turn in a group", async () => {
    const chats = rs.fn(async () => ({ chats: [] }));
    const calls = makeCalls({
      channelsService: {
        list: rs.fn(async () => []),
        send: rs.fn(),
        query: rs.fn(),
        chats,
      } as never,
    });

    await calls["channels.chats"]({ channel: "slack_app", query: "news", limit: 5 }, turnIn);

    expect(chats).toHaveBeenCalledTimes(1);
    expect(chats).toHaveBeenCalledWith("slack_app", { query: "news", limit: 5 });
  });

  it("passes on a request for threads and archived threads", async () => {
    const chats = rs.fn(async () => ({ chats: [] }));
    const calls = makeCalls({
      channelsService: { list: rs.fn(), send: rs.fn(), query: rs.fn(), chats } as never,
    });

    await calls["channels.chats"](
      { channel: "discord", includeThreads: true, includeArchivedThreads: true },
      turnIn,
    );

    expect(chats).toHaveBeenCalledWith("discord", {
      includeThreads: true,
      includeArchivedThreads: true,
    });
  });

  it("refuses on a host whose service lists no chats", async () => {
    const calls = makeCalls();
    await expect(calls["channels.chats"]({ channel: "slack_app" }, {})).rejects.toThrow(
      "This Rome lists no chats",
    );
  });
});
