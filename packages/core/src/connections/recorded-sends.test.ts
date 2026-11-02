// What an app's hook sends on a channel: said through the seat at that
// address, else in the chat Rome holds there, recorded once either way.
// Contract: docs/architecture/channels.md#chat-adapters.

import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import type { Channel, ChatId, MessageReceipt, OutgoingMessage } from "@rome-os/app-runtime";
import { sql } from "drizzle-orm";
import type { ChannelSend } from "../channels/channel.js";
import { ChatRepository } from "../chats/storage/chat-repository.js";
import { MessageRepository } from "../chats/storage/message-repository.js";
import { SeatReplies } from "../sessions/seat-replies.js";
import { Seats } from "../sessions/seats.js";
import { TurnLinks } from "../sessions/turn-links.js";
import { createTestDb, type TestDb } from "../test/helpers.js";
import { seatFixture } from "../test/seats.js";
import { ChatAddresses } from "./chat-addresses.js";
import { ChatAdapters, chatAt } from "./chat-adapter.js";
import { chatKey } from "./chat-ids.js";
import { emailChatAdapter } from "./email-chat-adapter.js";
import { recordedSends } from "./recorded-sends.js";

const BOT = { platform: "telegram", id: "rome-bot" };
const MAILBOX = { platform: "email", id: "rome@example.com" };

describe("recordedSends", () => {
  let testDb: TestDb;
  let sent: Array<{ channel: string; address: string; message: OutgoingMessage }>;
  let send: (channel: string) => ChannelSend;
  /** Where the port says a send to an address landed, when not there. */
  let landsAt: Record<string, string>;

  beforeEach(() => {
    testDb = createTestDb();
    sent = [];
    landsAt = {};
    let next = 0;
    /** A channel whose send port answers each message with the next id, at
     *  the address it names, or at a new email thread when it names none. */
    const channel = (name: string): Channel =>
      ({
        name,
        inbound: null,
        send: {
          send: async (address: ChatId, message: OutgoingMessage) => {
            sent.push({ channel: name, address, message });
            return {
              chatId: (landsAt[address] ?? (address || "thread-new")) as ChatId,
              messageId: `m-${++next}`,
            } satisfies MessageReceipt;
          },
        },
      }) as unknown as Channel;
    const accounts: Record<string, typeof BOT> = { telegram: BOT, email: MAILBOX };
    const chats = new ChatRepository(testDb.db);
    const messages = new MessageRepository(testDb.db);
    const seats = new Seats(testDb.db, chats);
    const adapters = new ChatAdapters({
      accountOf: (name) => accounts[name] ?? null,
      platformOfChannel: (name) => accounts[name]?.platform ?? name,
      addresses: new ChatAddresses(testDb.db),
      keyOf: (ref) => {
        const chat = chats.get(ref);
        if (!chat) throw new Error(`No chat ${ref.id}`);
        return chatKey(ref.platform, chat.key as ChatId);
      },
      channelsOn: (platform) =>
        Object.keys(accounts).filter((name) => accounts[name]?.platform === platform),
      platforms: { email: emailChatAdapter },
    });
    const replies = new SeatReplies({
      seats,
      adapters,
      messages,
      links: new TurnLinks(testDb.db, messages),
    });
    const wrapped = recordedSends([channel("telegram"), channel("email")], {
      adapters,
      chats,
      seats,
      replies,
      messages,
    });
    send = (name) => {
      const found = wrapped.find((c) => c.name === name);
      if (!found) throw new Error(`No channel ${name}`);
      return found.send as ChannelSend;
    };
  });
  afterEach(() => testDb.close());

  const lines = () =>
    testDb.db.all<{ chat: string; text: string; sender_agent: string | null }>(
      sql`SELECT c.key AS chat, m.text, m.sender_agent
        FROM chat_messages m JOIN chats c ON c.id = m.chat_id ORDER BY m.id`,
    );
  const sessions = () => testDb.db.all(sql`SELECT id FROM rome_sessions`);

  it("record a send at an address no seat heard in the chat there, and open no session", async () => {
    const receipt = await send("telegram").send("4242" as ChatId, { text: "Deploy done" });

    expect(receipt).toEqual({ chatId: "4242", messageId: "m-1" });
    expect(sent).toHaveLength(1);
    expect(lines()).toEqual([
      {
        chat: chatAt("telegram", "4242", { romeEnd: BOT.id }).externalId,
        text: "Deploy done",
        sender_agent: "main",
      },
    ]);
    expect(sessions()).toEqual([]);
  });

  it("record a send to a Telegram group Rome has not heard in the group's own chat", async () => {
    await send("telegram").send("-300" as ChatId, { text: "Hello group" });

    expect(testDb.db.all(sql`SELECT key, kind FROM chats`)).toEqual([
      { key: "-300", kind: "group" },
    ]);
  });

  it("say a send through the seat that heard the address, in the seat's chat", async () => {
    const fixture = seatFixture(testDb.db);
    const group = fixture.chat("telegram", "-200", "group");
    fixture.seat({ id: "seat-1", chat: group, accountId: BOT.id, agentName: "pm" });

    await send("telegram").send("-200" as ChatId, { text: "Standup in 5" });

    expect(sent).toMatchObject([{ address: "-200", message: { text: "Standup in 5" } }]);
    expect(lines()).toEqual([{ chat: "-200", text: "Standup in 5", sender_agent: "pm" }]);
    expect(sessions()).toEqual([{ id: "seat-1" }]);
  });

  it("say a send at a topic through the seat that heard the topic", async () => {
    const fixture = seatFixture(testDb.db);
    const group = fixture.chat("telegram", "-200", "group");
    fixture.seat({ id: "seat-1", chat: group, accountId: BOT.id, agentName: "pm" });
    fixture.seat({ id: "seat-2", chat: group, accountId: BOT.id, threadId: "topic-5" });

    await send("telegram").send("topic-5" as ChatId, { text: "In the topic" });

    expect(sent).toMatchObject([{ address: "topic-5" }]);
    expect(testDb.db.all(sql`SELECT thread_id, sender_agent FROM chat_messages`)).toEqual([
      { thread_id: "topic-5", sender_agent: "main" },
    ]);
  });

  it("send an email reply through the adapter, recorded once in its thread's chat", async () => {
    const fixture = seatFixture(testDb.db);
    const thread = fixture.chat("email", "thread-7", "group");
    fixture.say({
      id: "in-1",
      chat: thread,
      from: "wei@example.com",
      text: "Book it?",
      at: new Date(),
    });
    const reply = {
      kind: "email",
      text: "Thanks, booked.",
      inReplyToMessageId: "in-1",
    } as OutgoingMessage;

    const receipt = await send("email").send("thread-7" as ChatId, reply);

    expect(receipt).toEqual({ chatId: "thread-7", messageId: "m-1" });
    expect(sent).toEqual([
      {
        channel: "email",
        address: "thread-7",
        message: expect.objectContaining({ kind: "email", inReplyToMessageId: "in-1" }),
      },
    ]);
    expect(lines()).toEqual([
      { chat: "thread-7", text: "Book it?", sender_agent: null },
      { chat: "thread-7", text: "Thanks, booked.", sender_agent: "main" },
    ]);
    expect(sessions()).toEqual([]);
  });

  it("open a thread for an email that names none, record it once, and find the thread again", async () => {
    const receipt = await send("email").send(
      "" as ChatId,
      {
        kind: "email",
        to: "alice@example.com",
        subject: "Hello",
        text: "First note",
      } as OutgoingMessage,
    );

    expect(receipt).toEqual({ chatId: "thread-new", messageId: "m-1" });
    expect(sent).toEqual([
      {
        channel: "email",
        address: "",
        message: expect.objectContaining({ to: "alice@example.com", subject: "Hello" }),
      },
    ]);
    const [first] = lines();
    expect(first).toMatchObject({ text: "First note", sender_agent: "main" });
    expect(testDb.db.all(sql`SELECT kind, name FROM chats WHERE key = ${first?.chat}`)).toEqual([
      { kind: "group", name: "Hello" },
    ]);

    // The provider named the thread, which is the same chat from then on.
    await send("email").send("thread-new" as ChatId, { text: "Second note" });
    expect(sent[1]).toMatchObject({ address: "thread-new" });
    expect(lines().map((line) => line.chat)).toEqual([first?.chat, first?.chat]);
    expect(sessions()).toEqual([]);
  });

  it("answer the address a direct message landed at, and send there next", async () => {
    landsAt.alice = "dm-99";

    const receipt = await send("telegram").send("alice" as ChatId, { text: "Hi Alice" });
    await send("telegram").send("alice" as ChatId, { text: "Again" });

    expect(receipt).toEqual({ chatId: "dm-99", messageId: "m-1" });
    expect(sent.map((one) => one.address)).toEqual(["alice", "dm-99"]);
    expect(new Set(lines().map((line) => line.chat)).size).toBe(1);
  });

  it("reply to an email in its thread when the reply names no thread", async () => {
    await send("email").send("thread-7" as ChatId, { text: "Booked?" });

    const receipt = await send("email").send(
      "" as ChatId,
      { kind: "email", text: "Thanks", inReplyToMessageId: "m-1" } as OutgoingMessage,
    );

    expect(receipt).toEqual({ chatId: "thread-7", messageId: "m-2" });
    expect(sent[1]).toMatchObject({
      address: "thread-7",
      message: { kind: "email", inReplyToMessageId: "m-1" },
    });
    expect(lines().map((line) => line.chat)).toEqual(["thread-7", "thread-7"]);
  });

  it("record an email reply in the thread of the email it answers, whatever thread it names", async () => {
    await send("email").send("thread-7" as ChatId, { text: "Booked?" });

    const receipt = await send("email").send(
      "thread-9" as ChatId,
      { kind: "email", text: "Thanks", inReplyToMessageId: "m-1" } as OutgoingMessage,
    );

    expect(receipt.chatId).toBe("thread-7");
    expect(lines().map((line) => line.chat)).toEqual(["thread-7", "thread-7"]);
  });

  it("send no reply to an email Rome does not hold", async () => {
    await expect(
      send("email").send(
        "" as ChatId,
        { kind: "email", text: "Thanks", inReplyToMessageId: "unknown" } as OutgoingMessage,
      ),
    ).rejects.toThrow("Rome holds no email unknown");
    expect(sent).toEqual([]);
    expect(lines()).toEqual([]);
  });

  it("send no reply to an email Rome does not hold, even in a named thread", async () => {
    await expect(
      send("email").send(
        "thread-9" as ChatId,
        { kind: "email", text: "Thanks", inReplyToMessageId: "unknown" } as OutgoingMessage,
      ),
    ).rejects.toThrow("Rome holds no email unknown");
    expect(sent).toEqual([]);
  });

  it("record an HTML-only email by its text, and an attachment by a note", async () => {
    await send("email").send(
      "thread-7" as ChatId,
      { kind: "email", text: "", html: "<p>See <b>you</b></p>" } as OutgoingMessage,
    );
    await send("telegram").send("-100" as ChatId, {
      attachments: [{ type: "image", source: "/tmp/a.png", caption: "sunset" }],
    });

    await send("telegram").send("-100" as ChatId, {
      parts: [{ type: "text", content: "Look" }],
      attachments: [{ type: "document", source: "/tmp/r.pdf" }],
    });

    const [html, image, both] = lines().map((line) => line.text);
    expect(html).toMatch(/See .*you/);
    expect(image).toBe("[image: sunset]");
    expect(both).toBe("Look\n[document]");
  });

  it("send an email's reply recipients, and its text from its parts when it has none", async () => {
    await send("email").send(
      "thread-7" as ChatId,
      {
        kind: "email",
        parts: [{ type: "text", content: "From parts" }],
        cc: ["ann@example.com"],
        bcc: ["log@example.com"],
      } as OutgoingMessage,
    );

    expect(sent[0]?.message).toMatchObject({
      text: "From parts",
      cc: ["ann@example.com"],
      bcc: ["log@example.com"],
    });
  });

  it("keep a thread a plain message reaches on an email channel as a group", async () => {
    await send("email").send("thread-8" as ChatId, { text: "Plain" });

    expect(testDb.db.all(sql`SELECT key, kind FROM chats`)).toEqual([
      { key: "thread-8", kind: "group" },
    ]);
  });

  it("send a plain message to an email address or the guardian as a new email", async () => {
    const receipt = await send("email").send("alice@example.com" as ChatId, { text: "Hi" });
    await send("email").send("guardian" as ChatId, { text: "Report" });

    expect(receipt).toEqual({ chatId: "thread-new", messageId: "m-1" });
    expect(sent).toMatchObject([
      { address: "", message: { kind: "email", to: "alice@example.com", text: "Hi" } },
      { address: "", message: { kind: "email", to: "guardian", text: "Report" } },
    ]);
    expect(testDb.db.all(sql`SELECT kind FROM chats`)).toEqual([
      { kind: "group" },
      { kind: "group" },
    ]);
  });

  it("send a plain message to an address with a display name as a new email", async () => {
    await send("email").send("Alice <alice@example.com>" as ChatId, { text: "Hi" });

    expect(sent).toMatchObject([
      { address: "", message: { kind: "email", to: "Alice <alice@example.com>" } },
    ]);
  });

  it("send nothing and record nothing when the platform refuses", async () => {
    const [refusing] = recordedSends(
      [
        {
          name: "telegram",
          inbound: null,
          send: {
            send: async () => {
              throw new Error("bot was blocked");
            },
          },
        } as unknown as Channel,
      ],
      {
        adapters: new ChatAdapters({
          accountOf: () => BOT,
          platformOfChannel: () => "telegram",
          addresses: new ChatAddresses(testDb.db),
          keyOf: () => chatKey("telegram", "-100" as ChatId),
          channelsOn: () => ["telegram"],
        }),
        chats: new ChatRepository(testDb.db),
        seats: new Seats(testDb.db),
        replies: { send: async () => null },
        messages: new MessageRepository(testDb.db),
      },
    );

    await expect(
      (refusing?.send as ChannelSend).send("-100" as ChatId, { text: "hi" }),
    ).rejects.toThrow("bot was blocked");
    expect(lines()).toEqual([]);
  });
});
