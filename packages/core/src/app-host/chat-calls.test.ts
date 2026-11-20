import { describe, it, expect, rs } from "@rstest/core";
import { chatWorkerCalls, type ChatWorkerCallsDeps } from "./chat-calls.js";
import { createChannelsService } from "./accounts-service.js";
import { conciergeChatGuard } from "../concierge/automated-input.js";
import { createTestDb } from "../test/db.js";
import { ChatsWebChatRepository } from "../webchat/chats-webchat-repository.js";
import { refuseAnotherOwnersChat, webchatChannel } from "../webchat/dashboard-account.js";
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
        refuseAnotherOwnersChat: (chatId) => refuseAnotherOwnersChat(repo, chatId),
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

  it("refuses a send into another owner's Concierge chat, as the chat refuses any send", async () => {
    const { testDb, repo, runSystemTurn, calls } = await setup();
    const sendAs = (callerActionContext: Record<string, unknown>) =>
      calls["channels.send"](
        { channel: "webchat", chatId: "concierge", message: { text: "Wire the money." } },
        { callerActionContext },
      );
    try {
      // A visitor's agent, and an app action no person ran from a common chat.
      await expect(
        sendAs({
          actor: { kind: "visitor", userId: "v1", via: "cookie" },
          channelContext: { channel: "webchat", threadId: "plain" },
          agentName: "core:main",
        }),
      ).rejects.toThrow("No dashboard chat concierge");
      await expect(
        sendAs({
          channelContext: { channel: "webchat", threadId: "plain" },
          agentName: "core:main",
        }),
      ).rejects.toThrow("No dashboard chat concierge");
      expect(runSystemTurn).not.toHaveBeenCalled();
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

describe("channels.query from a turn that is not the guardian's", () => {
  const visitorOn = (threadId: string) => ({
    callerActionContext: {
      audience: "shared" as const,
      channelContext: {
        channel: "telegram",
        threadId,
        threadType: "private" as const,
        senderBondLevel: "other",
      },
    },
  });

  it("reads the chat the turn is in", async () => {
    const query = rs.fn(async () => []);
    const calls = makeCalls({
      channelsService: { list: rs.fn(), send: rs.fn(), query } as never,
    });

    await calls["channels.query"]({ channel: "telegram", chatId: "chat-a" }, visitorOn("chat-a"));

    expect(query).toHaveBeenCalledWith("telegram", { chatId: "chat-a" });
  });

  it("reads no other chat, nor every chat at once", async () => {
    const query = rs.fn(async () => [{ text: "the guardian's own words" }]);
    const calls = makeCalls({
      channelsService: { list: rs.fn(), send: rs.fn(), query } as never,
    });

    await expect(
      calls["channels.query"]({ channel: "telegram", chatId: "chat-b" }, visitorOn("chat-a")),
    ).rejects.toThrow("reads only the chat it is in");
    await expect(
      calls["channels.query"]({ channel: "whatsapp", chatId: "chat-a" }, visitorOn("chat-a")),
    ).rejects.toThrow("reads only the chat it is in");
    await expect(
      calls["channels.query"]({ channel: "telegram" }, visitorOn("chat-a")),
    ).rejects.toThrow("reads only the chat it is in");
    expect(query).not.toHaveBeenCalled();
  });

  it("reads its own chat when it names the chat by its account", async () => {
    const query = rs.fn(async () => []);
    const account = { platform: "telegram", id: "rome-bot" };
    const calls = makeCalls({
      channelsService: {
        list: rs.fn(async () => [
          { name: "whatsapp", account: { platform: "whatsapp", id: "rome-wa" } },
          { name: "telegram", account },
        ]),
        send: rs.fn(),
        query,
      } as never,
    });

    await calls["channels.query"]({ channel: account, chatId: "chat-a" }, visitorOn("chat-a"));
    expect(query).toHaveBeenCalledWith(account, { chatId: "chat-a" });
    await expect(
      calls["channels.query"](
        { channel: { platform: "whatsapp", id: "rome-wa" }, chatId: "chat-a" },
        visitorOn("chat-a"),
      ),
    ).rejects.toThrow("reads only the chat it is in");
  });

  it("reads the chat around a native thread the turn is in", async () => {
    const query = rs.fn(async () => []);
    const calls = makeCalls({
      channelsService: { list: rs.fn(), send: rs.fn(), query } as never,
    });
    const inThread = visitorOn("thread-1");
    const turn = {
      callerActionContext: {
        ...inThread.callerActionContext,
        channelContext: {
          ...inThread.callerActionContext.channelContext,
          parentThreadId: "chat-a",
        },
      },
    };

    await calls["channels.query"]({ channel: "telegram", chatId: "thread-1" }, turn);
    await calls["channels.query"]({ channel: "telegram", chatId: "chat-a" }, turn);
    expect(query).toHaveBeenCalledTimes(2);
    await expect(
      calls["channels.query"]({ channel: "telegram", chatId: "chat-b" }, turn),
    ).rejects.toThrow("reads only the chat it is in");
  });

  it("reads no chat from an agent turn with no chat of its own that others read", async () => {
    const query = rs.fn(async () => []);
    const calls = makeCalls({
      channelsService: { list: rs.fn(), send: rs.fn(), query } as never,
    });
    const read = (callerActionContext: object) =>
      calls["channels.query"]({ channel: "telegram", chatId: "chat-b" }, {
        callerActionContext,
      } as never);
    const guardian = { kind: "guardian" };

    // An agent a group turn summoned: the guardian acts, others read, and
    // there is no chat to read.
    await expect(read({ actor: guardian, audience: "shared", turnId: "t1" })).rejects.toThrow(
      "reads only the chat it is in",
    );
    // A third-party action in that turn carries no audience, and reads none.
    await expect(read({ actor: guardian, turnId: "t1" })).rejects.toThrow(
      "reads only the chat it is in",
    );
    // A private one reads any chat, and so does a routine's fire, which runs
    // outside any agent turn, and a call outside any action.
    await read({ actor: guardian, audience: "private", turnId: "t1" });
    await read({ actor: guardian, audience: "shared" });
    await calls["channels.query"]({ channel: "telegram", chatId: "chat-b" }, {});
    expect(query).toHaveBeenCalledTimes(3);
  });

  it("reads any chat only from a turn whose audience is private", async () => {
    const query = rs.fn(async () => []);
    const calls = makeCalls({
      channelsService: { list: rs.fn(async () => []), send: rs.fn(), query } as never,
    });
    const guardianIn = (channel: string, audience?: "private" | "shared") => ({
      callerActionContext: {
        ...(audience ? { audience } : {}),
        channelContext: {
          channel,
          threadId: "here",
          threadType: "private" as const,
          senderBondLevel: "guardian",
        },
      },
    });

    await calls["channels.query"](
      { channel: "whatsapp", chatId: "else" },
      guardianIn("telegram", "private"),
    );
    expect(query).toHaveBeenCalledTimes(1);
    // The guardian's own email thread, or a dashboard chat visitors can open,
    // is read by others: the host reads its audience as shared.
    for (const turn of [guardianIn("email", "shared"), guardianIn("webchat", "shared")]) {
      await expect(
        calls["channels.query"]({ channel: "whatsapp", chatId: "else" }, turn),
      ).rejects.toThrow("reads only the chat it is in");
    }
    // An action with no audience is not the host's own, and reads as shared.
    await expect(
      calls["channels.query"]({ channel: "whatsapp", chatId: "else" }, guardianIn("telegram")),
    ).rejects.toThrow("reads only the chat it is in");
    expect(query).toHaveBeenCalledTimes(1);
  });
});
