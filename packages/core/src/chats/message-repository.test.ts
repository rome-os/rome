import { beforeEach, afterEach, describe, expect, it } from "@rstest/core";
import type { ChatId } from "@rome-os/app-runtime";
import { WebChatRepository } from "../db/repositories/webchat.js";
import { createTestDb, type TestDb } from "../test/helpers.js";
import { ChatEvents } from "./events.js";
import { StoredMessages } from "./message-repository.js";
import { chatKey, placeIn } from "./place.js";

// Reading a place's messages. What these pin: pages run newest to oldest and
// each answers oldest first, only what was said is read, and a group two of
// Rome's accounts are in reads as one chat.

const textContent = (text: string) => JSON.stringify([{ type: "text", content: text }]);
const minute = (n: number) => new Date(Date.UTC(2026, 9, 29, 1, n));

describe("StoredMessages reads", () => {
  let testDb: TestDb;
  let rows: WebChatRepository;
  let messages: StoredMessages;

  beforeEach(() => {
    testDb = createTestDb();
    rows = new WebChatRepository(testDb.db);
    messages = new StoredMessages(rows, new ChatEvents(), {
      channelsOn: (platform) => (platform === "telegram" ? ["telegram", "telegram-sales"] : []),
      accountOf: (channel) =>
        channel === "telegram" ? { platform: "telegram", id: "rome-bot" } : null,
    });
  });

  afterEach(() => {
    testDb.close();
  });

  const group = placeIn(chatKey("telegram", "group-1" as ChatId));

  const said = async (sessionId: string, text: string, at: Date, platformMessageId: string) =>
    rows.addConversationMessage({
      sessionId,
      role: "notification",
      content: textContent(text),
      platformMessageId,
      senderId: "alice-tg",
      senderName: "Alice",
      createdAt: at,
    });

  it("pages from the newest message back, each page oldest first", async () => {
    const chat = await rows.ensureChannelChat({
      channel: "telegram",
      threadId: "group-1",
      agentName: "main",
    });
    for (let n = 1; n <= 5; n += 1) await said(chat.id, `line ${n}`, minute(n), `m-${n}`);

    const newest = await messages.recent(group, 2);
    expect(newest.messages.map((message) => message.body.text)).toEqual(["line 4", "line 5"]);
    expect(newest.older).not.toBeNull();

    const middle = await messages.before(group, newest.older!, 2);
    expect(middle.messages.map((message) => message.body.text)).toEqual(["line 2", "line 3"]);

    const oldest = await messages.before(group, middle.older!, 2);
    expect(oldest.messages.map((message) => message.body.text)).toEqual(["line 1"]);
    expect(oldest.older).toBeNull();
  });

  it("answers who said each message and which way it went", async () => {
    const chat = await rows.ensureChannelChat({
      channel: "telegram",
      threadId: "group-1",
      agentName: "main",
    });
    await said(chat.id, "hi Rome", minute(1), "m-1");
    await rows.recordOutboundConversationMessage({
      sessionId: chat.id,
      content: textContent("hi Alice"),
      platformMessageId: "m-2",
      senderId: "rome",
      senderName: "Rome",
      replyToPlatformMessageId: "m-1",
      knownToProvider: false,
    });

    const { messages: read } = await messages.recent(group, 10);
    expect(read).toMatchObject([
      {
        direction: "toRome",
        place: group,
        saidBy: { account: { platform: "telegram", id: "alice-tg" }, name: "Alice" },
        body: { text: "hi Rome" },
        platformMessageId: "m-1",
      },
      {
        direction: "fromRome",
        saidBy: { account: { platform: "telegram", id: "rome-bot" } },
        body: { text: "hi Alice" },
        platformMessageId: "m-2",
        replyTo: "m-1",
      },
    ]);
  });

  it("reads only what was said: no pending or refused send", async () => {
    const chat = await rows.ensureChannelChat({
      channel: "telegram",
      threadId: "group-1",
      agentName: "main",
    });
    const pending = (text: string) =>
      rows.recordPendingOutbound({
        sessionId: chat.id,
        content: textContent(text),
        senderId: "rome",
        senderName: "Rome",
        at: minute(1),
      });
    const sent = await pending("went out");
    const failed = await pending("refused");
    await pending("still going");
    await rows.setDelivery(sent.id, { state: "sent", at: minute(2) }, "m-sent");
    await rows.setDelivery(failed.id, { state: "failed", error: "no such chat", at: minute(2) });

    const { messages: read } = await messages.recent(group, 10);
    expect(read.map((message) => message.body.text)).toEqual(["went out"]);
  });

  it("reads a group two of Rome's accounts are in as one chat", async () => {
    const support = await rows.ensureChannelChat({
      channel: "telegram",
      threadId: "group-1",
      agentName: "main",
    });
    const sales = await rows.ensureChannelChat({
      channel: "telegram-sales",
      threadId: "group-1",
      agentName: "main",
    });
    // Both accounts received the same message, and each heard one of its own.
    await said(support.id, "hello both", minute(1), "m-1");
    await said(sales.id, "hello both", minute(1), "m-1");
    await said(sales.id, "sales only", minute(2), "m-2");

    const { messages: read } = await messages.recent(group, 10);
    expect(read.map((message) => message.platformMessageId)).toEqual(["m-1", "m-2"]);
  });

  it("keeps a thread's messages to the thread", async () => {
    const chat = await rows.ensureChannelChat({
      channel: "telegram",
      threadId: "group-1",
      agentName: "main",
    });
    const thread = await rows.ensureChannelChat({
      channel: "telegram",
      threadId: "group-1:topic-9",
      parentThreadId: "group-1",
      agentName: "main",
    });
    await said(chat.id, "in the chat", minute(1), "m-1");
    await said(thread.id, "in the thread", minute(2), "m-2");

    const inThread = placeIn(chatKey("telegram", "group-1" as ChatId), "group-1:topic-9" as ChatId);
    expect((await messages.recent(inThread, 10)).messages.map((m) => m.body.text)).toEqual([
      "in the thread",
    ]);
    expect((await messages.recent(group, 10)).messages.map((m) => m.body.text)).toEqual([
      "in the chat",
    ]);
  });

  it("answers an empty page for a place Rome holds nothing in", async () => {
    await expect(messages.recent(group, 10)).resolves.toEqual({ messages: [], older: null });
    const elsewhere = placeIn(chatKey("discord", "group-1" as ChatId));
    await expect(messages.recent(elsewhere, 10)).resolves.toEqual({ messages: [], older: null });
  });
});
