// What an app's hook sends on a channel: said through the seat at that
// address, else in the chat Rome holds there, recorded once either way, and
// never sent when it cannot be recorded. Contract:
// docs/architecture/channels.md#chat-adapters.

import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import type { Channel, ChatId, MessageReceipt, OutgoingMessage } from "@rome-os/app-runtime";
import { sql } from "drizzle-orm";
import { chatAt } from "../chats/adapter.js";
import { chatWiring } from "../chat-wiring.js";
import { WebChatRepository } from "../db/repositories/webchat.js";
import { createTestDb, type TestDb } from "../test/helpers.js";
import { seatFixture } from "../test/seats.js";
import type { ChannelSend } from "./channel.js";
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
    const webchatRepo = new WebChatRepository(testDb.db);
    const wiring = chatWiring(testDb.db, {
      accountOf: (name) => accounts[name] ?? null,
      platformOfChannel: (name) => accounts[name]?.platform ?? name,
      channelsOn: (platform) =>
        Object.keys(accounts).filter((n) => accounts[n]!.platform === platform),
      seats: webchatRepo,
    });
    const wrapped = recordedSends(channels, { ...wiring, webchatRepo });
    send = (name) => wrapped.find((c) => c.name === name)!.send as ChannelSend;
  });
  afterEach(() => testDb.close());

  const lines = () =>
    testDb.db.all<{ chat: string; text: string; sender_agent: string | null }>(
      sql`SELECT c.key AS chat, m.text, m.sender_agent
        FROM chat_messages m JOIN chats c ON c.id = m.chat_id ORDER BY m.id`,
    );
  const sessions = () => testDb.db.all(sql`SELECT id FROM rome_sessions`);

  it("records a send at an address no seat heard in the chat there, and opens no session", async () => {
    const receipt = await send("telegram").send("-100" as ChatId, { text: "Deploy done" });

    expect(receipt).toEqual({ chatId: "-100", messageId: "m-1" });
    expect(sent).toHaveLength(1);
    expect(lines()).toEqual([
      {
        chat: chatAt("telegram", "-100", { romeEnd: BOT.id }).externalId,
        text: "Deploy done",
        sender_agent: "main",
      },
    ]);
    expect(sessions()).toEqual([]);
  });

  it("says a send through the seat that heard the address, in the seat's chat", async () => {
    const fixture = seatFixture(testDb.db);
    const group = fixture.chat("telegram", "-200", "group");
    fixture.seat({ id: "seat-1", chat: group, accountId: BOT.id, agentName: "pm" });

    await send("telegram").send("-200" as ChatId, { text: "Standup in 5" });

    expect(lines()).toEqual([{ chat: "-200", text: "Standup in 5", sender_agent: "pm" }]);
    expect(sessions()).toEqual([{ id: "seat-1" }]);
  });

  it("sends nothing when the seat stands in no chat, so nothing goes out unrecorded", async () => {
    const fixture = seatFixture(testDb.db);
    // A seat in a topic the address names, whose chat is gone.
    const group = fixture.chat("telegram", "-3", "group");
    fixture.seat({ id: "seat-2", chat: group, accountId: BOT.id, threadId: "-300" });
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
    expect(lines()).toEqual([{ chat: "thread-7", text: "Thanks, booked.", sender_agent: "main" }]);
    expect(sessions()).toEqual([]);
  });

  it("opens a thread for an email that names none, records it once, and finds the thread again", async () => {
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
    expect(testDb.db.all(sql`SELECT kind, name FROM chats WHERE key = ${first!.chat}`)).toEqual([
      { kind: "group", name: "Hello" },
    ]);

    // The provider named the thread, which is the same chat from then on.
    await send("email").send("thread-new" as ChatId, { text: "Second note" });
    expect(sent[1]).toMatchObject({ address: "thread-new" });
    expect(lines().map((line) => line.chat)).toEqual([first!.chat, first!.chat]);
    expect(sessions()).toEqual([]);
  });
});
