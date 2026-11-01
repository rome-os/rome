// What an app's hook sends on a channel: said through the seat at that
// address, else in the chat Rome holds there, recorded once either way, and
// never sent when it cannot be recorded. Contract:
// docs/architecture/channels.md#chat-adapters.

import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import type { Channel, ChatId, MessageReceipt, OutgoingMessage } from "@rome-os/app-runtime";
import { sql } from "drizzle-orm";
import { ChatAdapters, chatAt } from "../chats/adapter.js";
import { ChatRepository } from "../chats/chat-repository.js";
import { MessageRepository } from "../chats/message-repository.js";
import { WebChatRepository } from "../db/repositories/webchat.js";
import { SeatReplies } from "../sessions/seat-replies.js";
import { TurnLinks } from "../sessions/turn-links.js";
import { createTestDb, type TestDb } from "../test/helpers.js";
import { seatFixture } from "../test/seats.js";
import type { ChannelSend } from "./channel.js";
import { ChatAddresses } from "./chat-addresses.js";
import { recordedSends } from "./recorded-sends.js";

const BOT = { platform: "telegram", id: "rome-bot" };
const MAILBOX = { platform: "email", id: "rome@example.com" };

describe("recordedSends", () => {
  let testDb: TestDb;
  let sent: Array<{ channel: string; address: string; message: OutgoingMessage }>;
  let send: (channel: string) => ChannelSend;

  beforeEach(() => {
    testDb = createTestDb();
    sent = [];
    let next = 0;
    /** A channel whose send port answers each message with the next id, at
     *  the address it names, or at a new email thread when it names none. */
    const channel = (name: string): Channel =>
      ({
        name,
        inbound: null,
        send: {
          send: rs.fn(async (address: ChatId, message: OutgoingMessage) => {
            sent.push({ channel: name, address, message });
            return {
              chatId: (address || "thread-new") as ChatId,
              messageId: `m-${++next}`,
            } satisfies MessageReceipt;
          }),
        },
      }) as unknown as Channel;
    const channels = [channel("telegram"), channel("email")];
    const accounts: Record<string, typeof BOT> = { telegram: BOT, email: MAILBOX };
    const adapters = new ChatAdapters({
      accountOf: (name) => accounts[name] ?? null,
      platformOfChannel: (name) => accounts[name]?.platform ?? name,
      addresses: new ChatAddresses(testDb.db),
      channelsOn: (platform) =>
        Object.keys(accounts).filter((n) => accounts[n]!.platform === platform),
    });
    const messages = new MessageRepository(testDb.db);
    const webchatRepo = new WebChatRepository(testDb.db);
    const wrapped = recordedSends(channels, {
      adapters,
      chats: new ChatRepository(testDb.db),
      webchatRepo,
      replies: new SeatReplies({
        seats: webchatRepo,
        adapters,
        messages,
        links: new TurnLinks(testDb.db),
      }),
      messages,
    });
    send = (name) => wrapped.find((c) => c.name === name)!.send as ChannelSend;
  });
  afterEach(() => testDb.close());

  const lines = () =>
    testDb.db.all<{ chat_id: string; text: string; sender_agent: string | null }>(
      sql`SELECT chat_id, text, sender_agent FROM chat_messages ORDER BY rowid`,
    );
  const sessions = () => testDb.db.all(sql`SELECT id FROM rome_sessions`);

  it("records a send at an address no seat heard in the chat there, and opens no session", async () => {
    const receipt = await send("telegram").send("-100" as ChatId, { text: "Deploy done" });

    expect(receipt).toEqual({ chatId: "-100", messageId: "m-1" });
    expect(sent).toHaveLength(1);
    expect(lines()).toEqual([
      {
        chat_id: chatAt("telegram", "-100", { romeEnd: BOT.id }).id,
        text: "Deploy done",
        sender_agent: "main",
      },
    ]);
    expect(sessions()).toEqual([]);
  });

  it("says a send through the seat that heard the address, in the seat's chat", async () => {
    const fixture = seatFixture(testDb.db);
    const group = fixture.chat("telegram", chatAt("telegram", "-200").id, "group");
    fixture.seat({ id: "seat-1", chat: group, accountId: BOT.id, agentName: "pm" });

    await send("telegram").send("-200" as ChatId, { text: "Standup in 5" });

    expect(lines()).toEqual([{ chat_id: group.id, text: "Standup in 5", sender_agent: "pm" }]);
    expect(sessions()).toEqual([{ id: "seat-1" }]);
  });

  it("sends nothing when the seat stands in no chat, so nothing goes out unrecorded", async () => {
    const fixture = seatFixture(testDb.db);
    const group = fixture.chat("telegram", chatAt("telegram", "-300").id, "group");
    fixture.seat({ id: "seat-2", chat: group, accountId: BOT.id });
    testDb.db.run(sql`DELETE FROM chats WHERE id = ${group.id}`);
    testDb.db.run(sql`UPDATE rome_sessions SET chat_id = ${group.id} WHERE id = 'seat-2'`);

    await expect(send("telegram").send("-300" as ChatId, { text: "Lost" })).rejects.toThrow();
    expect(sent).toEqual([]);
    expect(lines()).toEqual([]);
  });

  it("sends an email reply through the adapter, recorded once in its thread's chat", async () => {
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
      { chat_id: chatAt("email", "thread-7").id, text: "Thanks, booked.", sender_agent: "main" },
    ]);
    expect(sessions()).toEqual([]);
  });

  it("starts a thread for an email that names none, and records it there once", async () => {
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
    expect(sent).toHaveLength(1);
    expect(lines()).toEqual([
      { chat_id: chatAt("email", "thread-new").id, text: "First note", sender_agent: "main" },
    ]);
  });
});
