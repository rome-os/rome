import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import type { Channel, ChatId } from "@rome-os/app-runtime";
import { sql } from "drizzle-orm";
import { ChatRepository } from "../chats/storage/chat-repository.js";
import { MessageRepository } from "../chats/storage/message-repository.js";
import { placeIn, type ChatRef } from "../chats/storage/place.js";
import type { ChannelChatAdapter, Outbound, StreamedReply } from "../connections/chat-adapter.js";
import { chatKey } from "../connections/chat-ids.js";
import { systemClock } from "../lib/clock.js";
import { createTestDb, type TestDb } from "../test/helpers.js";
import { SeatReplies } from "./seat-replies.js";
import { Seats } from "./seats.js";
import { TurnLinks } from "./turn-links.js";

const CHANNEL = { name: "telegram" } as Channel;
const POLICY = {
  mode: "final",
  editIntervalMs: 0,
  blockWaitMs: 0,
  maxPendingChars: 10_000,
} as const;

describe("SeatReplies", () => {
  let testDb: TestDb;
  let chat: ChatRef;
  let messages: MessageRepository;
  let links: TurnLinks;
  let seats: Seats;
  let sends: Array<{ chat: string; threadId: ChatId | null; out: Outbound }>;
  let landsIn: ChatId | null;
  let refuse: boolean;
  let streamed: { text: string; key: string | null; threadId: ChatId | null };

  const adapter = {
    account: { platform: "telegram", id: "rome_bot" },
    async send(chatKey: string, threadId: ChatId | null, out: Outbound) {
      if (refuse) throw new Error("refused");
      sends.push({ chat: chatKey, threadId, out });
      return { key: `k${sends.length}`, threadId: landsIn ?? threadId };
    },
    stream(): StreamedReply {
      return {
        accept: () => {},
        stop: () => {},
        settle: async () => ({ outcome: {} as never, ...streamed }),
      };
    },
  } as unknown as ChannelChatAdapter;

  const replies = () =>
    new SeatReplies({
      seats,
      adapters: {
        of: () => adapter,
        keyOf: (ref) => chatKey(ref.platform, "-1001234567890123" as ChatId),
      },
      messages,
      links,
    });

  function seat(id: string, threadId: string | null, agent: string | null = "sales") {
    testDb.db.run(sql`
      INSERT INTO rome_sessions (id, name, type, chat_id, chat_platform, thread_id, account_id, agent_name, created_at, activity_at)
      VALUES (${id}, 'Seat', 'channel', ${chat.id}, 'telegram', ${threadId}, 'rome_bot', ${agent}, 0, 0)
    `);
  }

  beforeEach(() => {
    testDb = createTestDb();
    chat = new ChatRepository(testDb.db).start(
      { platform: "telegram", externalId: "-1001234567890123" as ChatId },
      "group",
      null,
    ).ref;
    messages = new MessageRepository(testDb.db);
    links = new TurnLinks(testDb.db, messages);
    seats = new Seats(testDb.db);
    sends = [];
    landsIn = null;
    refuse = false;
    streamed = { text: "All done.", key: "s1", threadId: null };
    seat("seat-1", null);
  });
  afterEach(() => testDb.close());

  it("send through the seat's adapter, on record as the seat's and as the turn's answer", async () => {
    const sent = await replies().send("seat-1", CHANNEL, { text: "hi" }, { turnId: "turn-1" });

    expect(sends).toEqual([
      { chat: "-1001234567890123", threadId: null, out: { text: "hi", turnId: "turn-1" } },
    ]);
    expect(sent).toMatchObject({ id: expect.any(Number), sent: "k1" });
    expect(messages.byIds([sent!.id!])[0]).toMatchObject({
      key: "k1",
      direction: "fromRome",
      saidBy: { account: { platform: "telegram", id: "rome_bot" }, agent: "sales" },
      body: { text: "hi" },
    });
    expect(links.linkOf("seat-1", sent!.id!)).toMatchObject({ role: "answer", turnId: "turn-1" });
  });

  it("record a send in the thread the platform placed it in", async () => {
    landsIn = "topic-7" as ChatId;

    const sent = await replies().send("seat-1", CHANNEL, { text: "hi" });

    expect(messages.byIds([sent!.id!])[0]?.place.threadId).toBe("topic-7");
    expect(messages.read(placeIn(chat)).messages).toEqual([]);
  });

  it("record nothing when the platform refuses a send", async () => {
    refuse = true;

    await expect(replies().send("seat-1", CHANNEL, { text: "hi" })).rejects.toThrow("refused");
    expect(messages.read(placeIn(chat)).messages).toEqual([]);
  });

  it("send nothing through a channel of another of Rome's accounts", async () => {
    const other = { ...adapter, account: { platform: "telegram", id: "other_bot" } };
    const wrong = new SeatReplies({
      seats,
      adapters: {
        of: () => other as ChannelChatAdapter,
        keyOf: () => chatKey("telegram", "-1" as ChatId),
      },
      messages,
      links,
    });

    await expect(wrong.send("seat-1", CHANNEL, { text: "hi" })).rejects.toThrow("other_bot");
    expect(sends).toEqual([]);
    expect(messages.read(placeIn(chat)).messages).toEqual([]);
  });

  it("say what a caller delivers, as the seat's", async () => {
    const said = await replies().say(
      "seat-1",
      [{ type: "text", content: "hello" }],
      async (to, key) => `${to.agent}:${key}`,
      { turnId: "turn-2" },
    );

    expect(messages.byIds([said!.id!])[0]).toMatchObject({
      key: "sales:-1001234567890123",
      body: { text: "hello" },
    });
    expect(links.linkOf("seat-1", said!.id!)).toMatchObject({ role: "answer", turnId: "turn-2" });
  });

  it("put a streamed reply on record as the turn's answer once it settles, where it landed", async () => {
    streamed = { text: "All done.", key: "s1", threadId: "topic-8" as ChatId };
    const reply = await replies().stream("seat-1", CHANNEL, {
      turnId: "turn-3",
      policy: POLICY,
      clock: systemClock,
    });

    await reply!.settle(false);

    const [line] = messages.read(placeIn(chat, "topic-8" as ChatId)).messages;
    expect(line).toMatchObject({ key: "s1", body: { text: "All done." } });
    expect(links.linkOf("seat-1", line!.id)).toMatchObject({ role: "answer", turnId: "turn-3" });
  });

  it("record nothing for a streamed reply that showed nothing", async () => {
    streamed = { text: "", key: null, threadId: null };
    const reply = await replies().stream("seat-1", CHANNEL, {
      turnId: "turn-3",
      policy: POLICY,
      clock: systemClock,
    });

    await reply!.settle(true);

    expect(messages.read(placeIn(chat)).messages).toEqual([]);
  });

  it("answer a delivered reply even when its turn link fails", async () => {
    const broken = new SeatReplies({
      seats,
      adapters: { of: () => adapter, keyOf: (ref) => chatKey(ref.platform, "x" as ChatId) },
      messages,
      links: {
        answer: () => {
          throw new Error("disk full");
        },
      },
    });

    const sent = await broken.send("seat-1", CHANNEL, { text: "hi" }, { turnId: "turn-1" });
    const said = await broken.say("seat-1", [{ type: "text", content: "yo" }], async () => "k9", {
      turnId: "turn-1",
    });

    expect(sent).toMatchObject({ id: expect.any(Number), sent: "k1" });
    expect(said).toMatchObject({ id: expect.any(Number) });
  });

  it("quote in a streamed reply only a line of the seat's own chat", async () => {
    const quotes: Array<string | undefined> = [];
    const quoting = {
      ...adapter,
      stream: (_chat: string, _thread: ChatId | null, out: { replyTo?: string }) => {
        quotes.push(out.replyTo);
        return adapter.stream?.(_chat, _thread, out as never) ?? null;
      },
    } as unknown as ChannelChatAdapter;
    const elsewhere = new ChatRepository(testDb.db).start(
      { platform: "telegram", externalId: "-1009999999999999" as ChatId },
      "group",
      null,
    ).ref;
    const heard = (ref: ChatRef) =>
      messages.record({
        direction: "toRome",
        key: "7",
        place: placeIn(ref),
        saidBy: { account: { platform: "telegram", id: "wei" } },
        body: { text: "q" },
        at: new Date(),
      })!.id;
    const here = heard(chat);
    const there = heard(elsewhere);
    const quotingReplies = new SeatReplies({
      seats,
      adapters: { of: () => quoting, keyOf: (ref) => chatKey(ref.platform, "x" as ChatId) },
      messages,
      links,
    });
    const options = { turnId: "turn-4", policy: POLICY, clock: systemClock };

    await quotingReplies.stream("seat-1", CHANNEL, { ...options, replyTo: here });
    await quotingReplies.stream("seat-1", CHANNEL, { ...options, replyTo: there });

    expect(quotes).toEqual(["7", undefined]);
  });

  it("send nothing for a session in no chat", async () => {
    testDb.db.run(sql`
      INSERT INTO rome_sessions (id, name, type, created_at, activity_at)
      VALUES ('run-1', 'Run', 'subagent', 0, 0)
    `);

    expect(await replies().send("run-1", CHANNEL, { text: "hi" })).toBeNull();
    expect(sends).toEqual([]);
  });
});

describe("Seats", () => {
  it("read a seat's place, account and agent, the main agent's when it kept none", () => {
    const testDb = createTestDb();
    const chat = new ChatRepository(testDb.db).start(
      { platform: "telegram", externalId: "-42" as ChatId },
      "group",
      null,
    ).ref;
    testDb.db.run(sql`
      INSERT INTO rome_sessions (id, name, type, chat_id, chat_platform, thread_id, created_at, activity_at)
      VALUES ('seat-1', 'Seat', 'channel', ${chat.id}, 'telegram', 'topic-1', 0, 0)
    `);

    expect(new Seats(testDb.db).seatOf("seat-1")).toEqual({
      sessionId: "seat-1",
      place: placeIn(chat, "topic-1" as ChatId),
      accountId: "telegram",
      agent: "main",
    });
    expect(new Seats(testDb.db).seatOf("nobody")).toBeNull();
    testDb.close();
  });
});
