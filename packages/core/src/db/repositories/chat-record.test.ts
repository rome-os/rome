import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { asc, eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "../../test/helpers.js";
import { chatAccounts, chatMessages, chatThreads, chats, channels } from "../schema.js";
import { WebChatRepository } from "./webchat.js";

const text = (content: string) => JSON.stringify([{ type: "text", content }]);

describe("chat record", () => {
  let testDb: TestDb;
  let repo: WebChatRepository;

  beforeEach(() => {
    testDb = createTestDb();
    repo = new WebChatRepository(testDb.db);
  });

  afterEach(() => {
    testDb.close();
  });

  function addChannel(id: string, platform: string) {
    testDb.db
      .insert(channels)
      .values({ id, connectionKind: platform, platform, createdAt: new Date() })
      .run();
  }

  function messagesOf(chatId: string) {
    return testDb.db
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.chatId, chatId))
      .orderBy(asc(chatMessages.saidAt))
      .all();
  }

  it("records one group once, whichever of Rome's accounts saw it", async () => {
    addChannel("feishu", "feishu");
    addChannel("feishu-sales", "feishu");
    const viaMain = await repo.ensureChannelChat({
      channel: "feishu",
      threadId: "oc_group",
      threadType: "group",
      agentName: "main",
    });
    const viaSales = await repo.ensureChannelChat({
      channel: "feishu-sales",
      threadId: "oc_group",
      threadType: "group",
      agentName: "sales",
    });
    for (const sessionId of [viaMain.id, viaSales.id]) {
      await repo.addConversationMessage({
        sessionId,
        role: "user",
        content: text("Q3 numbers?"),
        platformMessageId: "om_1",
        senderId: "ou_alice",
        senderName: "Alice",
      });
    }

    expect(testDb.db.select().from(chats).all()).toEqual([
      expect.objectContaining({
        id: "feishu:oc_group",
        platform: "feishu",
        platformChatId: "oc_group",
        kind: "group",
        romeChannel: null,
      }),
    ]);
    expect(
      testDb.db
        .select({ channel: chatAccounts.channel })
        .from(chatAccounts)
        .orderBy(asc(chatAccounts.channel))
        .all(),
    ).toEqual([{ channel: "feishu" }, { channel: "feishu-sales" }]);
    expect(messagesOf("feishu:oc_group")).toEqual([
      expect.objectContaining({
        platformMessageId: "om_1",
        platformThreadId: null,
        direction: "to_rome",
        senderId: "ou_alice",
        senderName: "Alice",
        parts: text("Q3 numbers?"),
      }),
    ]);
  });

  it("keeps two accounts' direct messages with one person as two chats", async () => {
    addChannel("telegram", "telegram");
    addChannel("telegram-sales", "telegram");
    for (const channel of ["telegram", "telegram-sales"]) {
      const chat = await repo.ensureChannelChat({
        channel,
        threadId: "4242",
        threadType: "private",
        agentName: "main",
      });
      await repo.addConversationMessage({
        sessionId: chat.id,
        role: "user",
        content: text("hi"),
        platformMessageId: "1",
      });
    }

    expect(
      testDb.db
        .select({ id: chats.id, kind: chats.kind, romeChannel: chats.romeChannel })
        .from(chats)
        .orderBy(asc(chats.id))
        .all(),
    ).toEqual([
      { id: "telegram:telegram-sales:4242", kind: "dm", romeChannel: "telegram-sales" },
      { id: "telegram:telegram:4242", kind: "dm", romeChannel: "telegram" },
    ]);
  });

  it("places a native thread's messages in its channel's chat, marked by thread", async () => {
    addChannel("discord", "discord");
    const channelChat = await repo.ensureChannelChat({
      channel: "discord",
      threadId: "channel-1",
      threadType: "group",
      agentName: "main",
    });
    const threadChat = await repo.ensureChannelChat({
      channel: "discord",
      threadId: "thread-1",
      parentThreadId: "channel-1",
      threadType: "group",
      agentName: "main",
    });
    await repo.addConversationMessage({
      sessionId: channelChat.id,
      role: "user",
      content: text("release today?"),
      platformMessageId: "m-1",
    });
    await repo.addConversationMessage({
      sessionId: threadChat.id,
      role: "user",
      content: text("yes, after QA"),
      platformMessageId: "m-2",
    });

    expect(testDb.db.select({ id: chats.id }).from(chats).all()).toEqual([
      { id: "discord:channel-1" },
    ]);
    expect(
      testDb.db
        .select({ chatId: chatThreads.chatId, platformThreadId: chatThreads.platformThreadId })
        .from(chatThreads)
        .all(),
    ).toEqual([{ chatId: "discord:channel-1", platformThreadId: "thread-1" }]);
    expect(
      messagesOf("discord:channel-1").map((m) => [m.platformMessageId, m.platformThreadId]),
    ).toEqual([
      ["m-1", null],
      ["m-2", "thread-1"],
    ]);
  });

  it("records what Rome said on a platform once its message id is known", async () => {
    addChannel("feishu", "feishu");
    const chat = await repo.ensureChannelChat({
      channel: "feishu",
      threadId: "oc_group",
      threadType: "group",
      agentName: "main",
    });
    await repo.recordOutboundConversationMessage({
      sessionId: chat.id,
      content: text("not delivered"),
      knownToProvider: true,
      turnId: "t-0",
    });
    await repo.recordOutboundConversationMessage({
      sessionId: chat.id,
      content: text("Q3 was €1.24M."),
      platformMessageId: "om_2",
      senderId: "ou_sales_bot",
      knownToProvider: true,
      turnId: "t-1",
    });
    await repo.recordOutboundConversationMessage({
      sessionId: chat.id,
      content: text("Q3 was €1.24M."),
      platformMessageId: "om_2",
      knownToProvider: true,
      turnId: "t-1",
    });

    expect(messagesOf("feishu:oc_group")).toEqual([
      expect.objectContaining({
        platformMessageId: "om_2",
        direction: "from_rome",
        senderId: "ou_sales_bot",
        agentName: null,
        parts: text("Q3 was €1.24M."),
      }),
    ]);
  });

  it("records the dashboard chat's messages, not its traces", async () => {
    await repo.createSession("chat-1", "Calendar");
    const said = JSON.stringify([{ type: "text", content: "What's on tomorrow?" }]);
    await repo.recordUserInput("in-1", "chat-1", said);
    await repo.addMessage("trace-1", "chat-1", "trace", "[]", "t-1");
    await repo.addMessage(
      "out-1",
      "chat-1",
      "assistant",
      JSON.stringify([{ type: "text", content: "10:00 design review." }]),
      "t-1",
    );

    expect(testDb.db.select().from(chats).all()).toEqual([
      expect.objectContaining({ id: "rome:chat-1", kind: "dashboard", platform: "rome" }),
    ]);
    expect(
      messagesOf("rome:chat-1").map((m) => [m.platformMessageId, m.direction, m.agentName]),
    ).toEqual([
      ["in-1", "to_rome", null],
      ["out-1", "from_rome", "main"],
    ]);
  });

  it("leaves a platform conversation's agent transcript out of the chat", async () => {
    addChannel("feishu", "feishu");
    const chat = await repo.ensureChannelChat({
      channel: "feishu",
      threadId: "oc_group",
      threadType: "group",
      agentName: "main",
    });
    await repo.addMessage("row-1", chat.id, "assistant", text("draft reply"), "t-1");

    expect(testDb.db.select().from(chatMessages).all()).toEqual([]);
  });

  it("removes a dashboard chat's record with the chat", async () => {
    await repo.createSession("chat-1", "Calendar");
    await repo.recordUserInput("in-1", "chat-1", text("hello"));

    await repo.deleteSession("chat-1");

    expect(testDb.db.select().from(chats).all()).toEqual([]);
    expect(testDb.db.select().from(chatMessages).all()).toEqual([]);
  });
});
