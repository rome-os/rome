import { beforeEach, afterEach, describe, expect, it } from "@rstest/core";
import type { ChatId } from "@rome-os/app-runtime";
import { WebChatRepository } from "../db/repositories/webchat.js";
import { createTestDb, type TestDb } from "../test/helpers.js";
import { ChatEvents } from "./events.js";
import { StoredMessages } from "./message-repository.js";
import { chatKey, placeIn } from "./place.js";

// Reading a place's messages. What these pin: pages run newest to oldest and
// each answers oldest first, and a group two of Rome's accounts are in reads as
// one chat.

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
      channelsOn: (platform) =>
        platform === "telegram" ? ["telegram", "telegram-sales", "telegram-ops"] : [],
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
      threadType: "group",
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
      threadType: "group",
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

  it("reads a group two of Rome's accounts are in as one chat", async () => {
    const support = await rows.ensureChannelChat({
      channel: "telegram",
      threadId: "group-1",
      threadType: "group",
      agentName: "main",
    });
    const sales = await rows.ensureChannelChat({
      channel: "telegram-sales",
      threadId: "group-1",
      threadType: "group",
      agentName: "main",
    });
    // Both accounts received the same message, and each heard one of its own.
    await said(support.id, "hello both", minute(1), "m-1");
    await said(sales.id, "hello both", minute(1), "m-1");
    await said(sales.id, "sales only", minute(2), "m-2");

    const { messages: read } = await messages.recent(group, 10);
    expect(read.map((message) => message.platformMessageId)).toEqual(["m-1", "m-2"]);
  });

  it("keeps a group message where its first copy put it when a later copy arrives", async () => {
    const support = await rows.ensureChannelChat({
      channel: "telegram",
      threadId: "group-1",
      threadType: "group",
      agentName: "main",
    });
    const sales = await rows.ensureChannelChat({
      channel: "telegram-sales",
      threadId: "group-1",
      threadType: "group",
      agentName: "main",
    });
    // Two messages in one second reach one account, then both reach the other.
    await said(support.id, "second", minute(1), "m-2");
    await said(support.id, "third", minute(1), "m-3");
    const newest = await messages.recent(group, 1);
    await said(sales.id, "second", minute(1), "m-2");
    await said(sales.id, "third", minute(1), "m-3");

    expect((await messages.recent(group, 10)).messages.map((m) => m.platformMessageId)).toEqual([
      "m-2",
      "m-3",
    ]);
    expect(newest.messages.map((m) => m.platformMessageId)).toEqual(["m-3"]);
    const older = await messages.before(group, newest.older!, 10);
    expect(older.messages.map((m) => m.platformMessageId)).toEqual(["m-2"]);
  });

  it("reads a reply shown as several messages once, whichever account heard its parts", async () => {
    const support = await rows.ensureChannelChat({
      channel: "telegram",
      threadId: "group-1",
      threadType: "group",
      agentName: "main",
    });
    const sales = await rows.ensureChannelChat({
      channel: "telegram-sales",
      threadId: "group-1",
      threadType: "group",
      agentName: "main",
    });
    const reply = (first: string, second: string) =>
      rows.recordOutboundConversationMessage({
        sessionId: support.id,
        content: textContent(`${first} ${second}`),
        platformMessageId: first,
        otherPlatformMessageIds: [second],
        senderId: "rome",
        senderName: "Rome",
        knownToProvider: false,
      });
    const read = async () =>
      (await messages.recent(group, 10)).messages.map((message) => message.body.text);

    // Sales hears the parts after Rome recorded its reply: the reply stands.
    await reply("p-1", "p-2");
    await said(sales.id, "p-1", minute(1), "p-1");
    await said(sales.id, "p-2", minute(1), "p-2");
    expect(await read()).toEqual(["p-1 p-2"]);

    // Sales hears the parts first: the reply still stands for them.
    await said(sales.id, "q-1", minute(2), "q-1");
    await said(sales.id, "q-2", minute(2), "q-2");
    await reply("q-1", "q-2");
    expect(await read()).toEqual(["p-1 p-2", "q-1 q-2"]);
  });

  it("reads the whole reply when another account heard a part before it was recorded", async () => {
    const support = await rows.ensureChannelChat({
      channel: "telegram",
      threadId: "group-1",
      threadType: "group",
      agentName: "main",
    });
    const sales = await rows.ensureChannelChat({
      channel: "telegram-sales",
      threadId: "group-1",
      threadType: "group",
      agentName: "main",
    });
    // Sales hears the first part, Rome records the whole, then sales hears the second.
    await said(sales.id, "r-1", minute(1), "r-1");
    await rows.recordOutboundConversationMessage({
      sessionId: support.id,
      content: textContent("r-1 r-2"),
      platformMessageId: "r-1",
      otherPlatformMessageIds: ["r-2"],
      senderId: "rome",
      senderName: "Rome",
      knownToProvider: false,
    });
    await said(sales.id, "r-2", minute(1), "r-2");

    const { messages: read } = await messages.recent(group, 10);
    expect(read.map((message) => message.body.text)).toEqual(["r-1 r-2"]);
  });

  it("reads a streamed reply whole when it is named by its last part", async () => {
    const support = await rows.ensureChannelChat({
      channel: "telegram",
      threadId: "group-1",
      threadType: "group",
      agentName: "main",
    });
    const sales = await rows.ensureChannelChat({
      channel: "telegram-sales",
      threadId: "group-1",
      threadType: "group",
      agentName: "main",
    });
    // A streamed reply is named by its last block. Sales hears the first,
    // Rome records the whole, then sales hears the last.
    await said(sales.id, "Looking.", minute(1), "s-1");
    await rows.recordOutboundConversationMessage({
      sessionId: support.id,
      content: textContent("Looking.\n\nAnswer"),
      platformMessageId: "s-2",
      otherPlatformMessageIds: ["s-1"],
      senderId: "rome",
      senderName: "Rome",
      knownToProvider: false,
    });
    await said(sales.id, "Answer", minute(1), "s-2");

    const { messages: read } = await messages.recent(group, 10);
    expect(read.map((message) => message.body.text)).toEqual(["Looking.\n\nAnswer"]);
  });

  it("reads a whole reply when another account heard only one of its parts", async () => {
    const support = await rows.ensureChannelChat({
      channel: "telegram",
      threadId: "group-1",
      threadType: "group",
      agentName: "main",
    });
    const sales = await rows.ensureChannelChat({
      channel: "telegram-sales",
      threadId: "group-1",
      threadType: "group",
      agentName: "main",
    });
    await said(sales.id, "Looking.", minute(1), "o-1");
    await rows.recordOutboundConversationMessage({
      sessionId: support.id,
      content: textContent("Looking. Found it. Answer"),
      platformMessageId: "o-3",
      otherPlatformMessageIds: ["o-1", "o-2"],
      senderId: "rome",
      senderName: "Rome",
      knownToProvider: false,
    });

    const { messages: read } = await messages.recent(group, 10);
    expect(read.map((message) => message.body.text)).toEqual(["Looking. Found it. Answer"]);
  });

  it("reads a reply once however many accounts heard its parts, in any order", async () => {
    const chatOf = (channel: string) =>
      rows.ensureChannelChat({
        channel,
        threadId: "group-1",
        threadType: "group",
        agentName: "main",
      });
    const support = await chatOf("telegram");
    const sales = await chatOf("telegram-sales");
    const ops = await chatOf("telegram-ops");
    await said(sales.id, "r-1", minute(1), "r-1");
    await rows.recordOutboundConversationMessage({
      sessionId: support.id,
      content: textContent("r-1 r-2"),
      platformMessageId: "r-1",
      otherPlatformMessageIds: ["r-2"],
      senderId: "rome",
      senderName: "Rome",
      knownToProvider: false,
    });
    await said(sales.id, "r-2", minute(1), "r-2");
    await said(ops.id, "r-2", minute(1), "r-2");

    const { messages: read } = await messages.recent(group, 10);
    expect(read.map((message) => message.body.text)).toEqual(["r-1 r-2"]);
  });

  it("reads a group as one account heard it when the read names that account", async () => {
    const support = await rows.ensureChannelChat({
      channel: "telegram",
      threadId: "group-1",
      threadType: "group",
      agentName: "main",
    });
    const sales = await rows.ensureChannelChat({
      channel: "telegram-sales",
      threadId: "group-1",
      threadType: "group",
      agentName: "main",
    });
    await said(support.id, "both heard", minute(1), "m-1");
    await said(sales.id, "both heard", minute(1), "m-1");
    await said(sales.id, "sales only", minute(2), "m-2");

    const viaSales = await messages.recent(group, 10, { channel: "telegram-sales" });
    expect(viaSales.messages.map((message) => message.id)).toHaveLength(2);
    const viaSupport = await messages.recent(group, 10, { channel: "telegram" });
    expect(viaSupport.messages.map((message) => message.platformMessageId)).toEqual(["m-1"]);
  });

  it("keeps a direct message to the one of Rome's accounts it was written to", async () => {
    // Telegram keys a direct message by the other person, so Alice writing to
    // two of Rome's bots leaves two chats at one address.
    const support = await rows.ensureChannelChat({
      channel: "telegram",
      threadId: "alice-tg",
      threadType: "private",
      agentName: "main",
    });
    const sales = await rows.ensureChannelChat({
      channel: "telegram-sales",
      threadId: "alice-tg",
      threadType: "private",
      agentName: "main",
    });
    await said(support.id, "for support", minute(1), "1");
    await said(sales.id, "for sales", minute(2), "1");
    const dm = placeIn(chatKey("telegram", "alice-tg" as ChatId));

    const read = async (channel?: string) =>
      (await messages.recent(dm, 10, channel ? { channel } : undefined)).messages.map(
        (message) => message.body.text,
      );
    expect(await read("telegram")).toEqual(["for support"]);
    expect(await read("telegram-sales")).toEqual(["for sales"]);
    // Read through no account, the address names two chats, so neither is read.
    expect(await read()).toEqual([]);
  });

  it("keeps a thread's messages to the thread", async () => {
    const chat = await rows.ensureChannelChat({
      channel: "telegram",
      threadId: "group-1",
      threadType: "group",
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

  it("reads a group's thread two of Rome's accounts are in as one", async () => {
    const thread = (channel: string) =>
      rows.ensureChannelChat({
        channel,
        threadId: "group-1:topic-9",
        parentThreadId: "group-1",
        agentName: "main",
      });
    const support = await thread("telegram");
    const sales = await thread("telegram-sales");
    await said(support.id, "both heard", minute(1), "m-1");
    await said(sales.id, "both heard", minute(1), "m-1");
    await said(sales.id, "sales only", minute(2), "m-2");

    const inThread = placeIn(chatKey("telegram", "group-1" as ChatId), "group-1:topic-9" as ChatId);
    expect((await messages.recent(inThread, 10)).messages.map((m) => m.platformMessageId)).toEqual([
      "m-1",
      "m-2",
    ]);
  });

  it("finds the named messages said in a place, oldest first", async () => {
    const chat = await rows.ensureChannelChat({
      channel: "telegram",
      threadId: "group-1",
      threadType: "group",
      agentName: "main",
    });
    for (let n = 1; n <= 4; n += 1) await said(chat.id, `line ${n}`, minute(n), `m-${n}`);
    const ids = (await messages.recent(group, 10)).messages.map((message) => message.id);

    const found = await messages.find(group, [ids[3]!, ids[0]!, "elsewhere"], {
      channel: "telegram",
    });
    expect(found.map((message) => message.body.text)).toEqual(["line 1", "line 4"]);
    await expect(messages.find(group, [])).resolves.toEqual([]);
  });

  it("answers an empty page for a place Rome holds nothing in", async () => {
    await expect(messages.recent(group, 10)).resolves.toEqual({ messages: [], older: null });
    const elsewhere = placeIn(chatKey("discord", "group-1" as ChatId));
    await expect(messages.recent(elsewhere, 10)).resolves.toEqual({ messages: [], older: null });
  });
});
