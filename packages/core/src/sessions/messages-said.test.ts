import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import type {
  Account,
  Channel,
  ChannelMessage,
  ChatId,
  InboundEvent,
  SaidInboundEvent,
} from "@rome-os/app-runtime";
import { eq } from "drizzle-orm";
import { chatsWiring } from "../chats-wiring.js";
import { ChatEvents } from "../chats/storage/events.js";
import { inboundRecording } from "../connections/inbound-recording.js";
import { WebChatRepository } from "../db/repositories/webchat.js";
import { chatMessages, romeSessions } from "../db/schema.js";
import { createTestDb, type TestDb } from "../test/helpers.js";
import { messagesSaid } from "./messages-said.js";

// Recording what reaches Rome in Chats' tables, then Agents hearing it. What
// these pin: a message is on record in its chat before the hook hears it, the
// hook hears it through the session of the account that heard it, a
// redelivery is neither recorded nor heard twice, a message is held out of
// catch-up until its wake is decided, and nothing is recorded until a hook
// subscribes.

const BOT: Account = { platform: "telegram", id: "rome-bot" };
const GROUP = "-100200" as ChatId;

function message(overrides: Partial<ChannelMessage> = {}): ChannelMessage {
  return {
    channel: "telegram",
    account: BOT,
    direction: "inbound",
    messageId: "tg-1",
    chatId: GROUP,
    senderId: "alice-tg",
    senderDisplayName: "Alice",
    text: "Hello",
    attachments: [],
    timestamp: new Date("2026-10-29T01:00:00Z"),
    thread: { kind: "group", name: "Team" },
    ...overrides,
  };
}

/** A channel whose deliveries the test drives. */
function fakeChannel(name: string) {
  const handlers: ((event: InboundEvent) => Promise<void>)[] = [];
  const channel: Channel = {
    name,
    send: null,
    inbound: {
      subscribe: (handler) => {
        handlers.push(handler);
        return () => handlers.splice(handlers.indexOf(handler), 1);
      },
      media: null,
    },
  };
  const deliver = async (incoming: ChannelMessage) => {
    for (const handler of handlers) {
      await handler({
        kind: "message",
        message: incoming,
        ref: { connectionId: `connection:${name}`, chatId: incoming.chatId },
      });
    }
  };
  return { channel, deliver, handlers };
}

describe("messagesSaid", () => {
  let testDb: TestDb;
  let wiring: ReturnType<typeof chatsWiring>;
  let telegram: ReturnType<typeof fakeChannel>;
  let said: ReturnType<typeof messagesSaid>;

  beforeEach(() => {
    testDb = createTestDb();
    wiring = chatsWiring(testDb.db, {
      accountOf: (channel) => (channel === "telegram" ? BOT : null),
      platformOfChannel: () => "telegram",
      channelsOn: () => ["telegram"],
    });
    telegram = fakeChannel("telegram");
    const events = new ChatEvents();
    const recording = inboundRecording(
      { chats: wiring.chats, messages: wiring.messages, events, adapters: wiring.adapters },
      [telegram.channel],
    );
    said = messagesSaid({
      chats: wiring.chats,
      sessions: new WebChatRepository(testDb.db),
      recording,
      events,
      wakes: wiring.links,
    });
  });
  afterEach(() => testDb.close());

  const lines = () => testDb.db.select().from(chatMessages).all();
  /** Waits for every delivery the adapter queued to be heard. */
  const settled = () => wiring.adapters.of(telegram.channel).settled();

  it("records nothing until a hook subscribes", async () => {
    await telegram.deliver(message());
    expect(telegram.handlers).toHaveLength(0);
    expect(lines()).toHaveLength(0);
  });

  it("records a message in its chat before the hook hears it, through the account's session", async () => {
    const heard: SaidInboundEvent[] = [];
    let linesWhenHeard = -1;
    said.subscribe(async (event) => {
      linesWhenHeard = lines().length;
      heard.push(event);
    });
    await telegram.deliver(message());
    await settled();

    expect(linesWhenHeard).toBe(1);
    expect(heard).toHaveLength(1);
    const [event] = heard;
    expect(event?.message.text).toBe("Hello");
    const line = lines()[0];
    expect(event?.recorded.messageId).toBe(String(line?.id));
    const session = testDb.db
      .select()
      .from(romeSessions)
      .where(eq(romeSessions.id, event?.recorded.chatRecordId ?? ""))
      .get();
    expect(session?.chatId).toBe(line?.chatId);
    expect(session?.accountId).toBe(BOT.id);
    expect(session?.threadId).toBeNull();
  });

  it("neither records nor hears a redelivery twice", async () => {
    const heard: SaidInboundEvent[] = [];
    said.subscribe(async (event) => {
      heard.push(event);
    });
    await telegram.deliver(message());
    await telegram.deliver(message());
    await settled();
    expect(lines()).toHaveLength(1);
    expect(heard).toHaveLength(1);
  });

  it("holds a message out of catch-up until its wake is decided", async () => {
    const heard: SaidInboundEvent[] = [];
    said.subscribe(async (event) => {
      heard.push(event);
    });
    // Said after the session opens, as a later line would be.
    await telegram.deliver(message({ timestamp: new Date(Date.now() + 60_000) }));
    await settled();
    const [event] = heard;
    if (!event) throw new Error("not heard");
    const session = event.recorded.chatRecordId;
    expect(wiring.links.unseen(session)).toHaveLength(0);
    await said.decided(event.recorded);
    expect(wiring.links.unseen(session).map((line) => line.text)).toEqual(["Hello"]);
  });

  it("stops recording once the last hook leaves", async () => {
    const leave = said.subscribe(async () => undefined);
    leave();
    await telegram.deliver(message());
    expect(lines()).toHaveLength(0);
  });
});
