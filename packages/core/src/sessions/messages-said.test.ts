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
import type { TurnLinks } from "./turn-links.js";

// Recording what reaches Rome in Chats' tables, then Agents hearing it. What
// these pin: a message is on record in its chat before the hook hears it, the
// hook hears it through the session of the account that heard it, a
// redelivery is neither recorded nor heard twice, a message is held out of
// catch-up until its wake is decided, and nothing is recorded until a hook
// subscribes.

const BOT: Account = { platform: "telegram", id: "rome-bot" };
const SECOND: Account = { platform: "telegram", id: "rome-bot-2" };
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
  let second: ReturnType<typeof fakeChannel>;
  let said: ReturnType<typeof messagesSaid>;

  function build(
    overrides: {
      sessions?: Pick<WebChatRepository, "ensureChannelChat">;
      wakes?: Pick<TurnLinks, "wakeUndecided" | "wakeDecided">;
    } = {},
  ) {
    const events = new ChatEvents();
    const recording = inboundRecording(
      { chats: wiring.chats, messages: wiring.messages, events, adapters: wiring.adapters },
      [telegram.channel, second.channel],
    );
    return messagesSaid({
      chats: wiring.chats,
      sessions: overrides.sessions ?? new WebChatRepository(testDb.db),
      recording,
      events,
      wakes: overrides.wakes ?? wiring.links,
    });
  }

  beforeEach(() => {
    testDb = createTestDb();
    const accounts: Record<string, Account> = { telegram: BOT, "telegram-2": SECOND };
    wiring = chatsWiring(testDb.db, {
      accountOf: (channel) => accounts[channel] ?? null,
      platformOfChannel: () => "telegram",
      channelsOn: () => Object.keys(accounts),
    });
    telegram = fakeChannel("telegram");
    second = fakeChannel("telegram-2");
    said = build();
  });
  afterEach(() => testDb.close());

  const lines = () => testDb.db.select().from(chatMessages).all();
  /** Waits for every delivery the adapter queued to be heard. */
  const settled = async () => {
    await wiring.adapters.of(telegram.channel).settled();
    await wiring.adapters.of(second.channel).settled();
  };

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

  it("raises a line two of Rome's accounts heard once for each, recorded once", async () => {
    const heard: SaidInboundEvent[] = [];
    said.subscribe(async (event) => {
      heard.push(event);
    });
    // A supergroup numbers its messages once for every member.
    const supergroup = { chatId: "-1001234567890" as ChatId };
    await telegram.deliver(message(supergroup));
    await second.deliver(message({ ...supergroup, account: SECOND, channel: "telegram-2" }));
    await second.deliver(message({ ...supergroup, account: SECOND, channel: "telegram-2" }));
    await settled();

    expect(lines()).toHaveLength(1);
    expect(heard.map((event) => event.message.channel)).toEqual(["telegram", "telegram-2"]);
    expect(new Set(heard.map((event) => event.recorded.messageId)).size).toBe(1);
    expect(new Set(heard.map((event) => event.recorded.chatRecordId)).size).toBe(2);
  });

  it("decides the wake of a message whose session could not be opened", async () => {
    const decided: number[] = [];
    const failing = build({
      sessions: {
        ensureChannelChat: async () => {
          throw new Error("disk full");
        },
      },
      wakes: { wakeUndecided: () => undefined, wakeDecided: (id) => decided.push(id) },
    });
    const heard: SaidInboundEvent[] = [];
    failing.subscribe(async (event) => {
      heard.push(event);
    });
    await telegram.deliver(message());
    await settled();

    expect(heard).toHaveLength(0);
    expect(decided).toEqual([lines()[0]?.id]);
  });

  it("drops what is still queued when the last hook leaves", async () => {
    let release = () => {};
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let hearing = () => {};
    const firstHeard = new Promise<void>((resolve) => {
      hearing = resolve;
    });
    const heard: string[] = [];
    const leave = said.subscribe(async (event) => {
      heard.push(event.message.messageId);
      hearing();
      await blocked;
    });
    await telegram.deliver(message({ messageId: "tg-1" }));
    await telegram.deliver(message({ messageId: "tg-2" }));
    await firstHeard;
    leave();
    release();
    await settled();

    expect(heard).toEqual(["tg-1"]);
    expect(lines()).toHaveLength(1);
  });

  it("stops recording once the last hook leaves", async () => {
    const leave = said.subscribe(async () => undefined);
    leave();
    await telegram.deliver(message());
    expect(lines()).toHaveLength(0);
  });
});
