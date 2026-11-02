import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import type { Channel, ChannelMessage, ChatId, InboundEvent } from "@rome-os/app-runtime";
import { createTestDb, testChatWiring, type TestDb } from "../test/helpers.js";
import { ChatEvents, type MessageSaid } from "./events.js";
import { inboundRecording } from "./inbound.js";
import { placeIn } from "./place.js";

// Recording what reaches Rome, then hearing it. What these pin: a message is
// on record in its chat before anything hears it, a redelivery is neither
// recorded nor heard twice, and nothing is recorded until someone listens.

const GROUP = "-100" as ChatId;

function message(overrides: Partial<ChannelMessage> = {}): ChannelMessage {
  return {
    channel: "telegram",
    account: { platform: "telegram", id: "rome-bot" },
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
    for (const handler of [...handlers]) {
      await handler({
        kind: "message",
        message: incoming,
        ref: { connectionId: `connection:${name}`, chatId: incoming.chatId },
      });
    }
  };
  return { channel, deliver, handlers };
}

/** The platform's own id in a recorded message key, which the adapter scopes
 *  by account in a Telegram basic group. */
const platformId = (key: string) => key.split(":").at(-1);

describe("inboundRecording", () => {
  let testDb: TestDb;
  let wiring: ReturnType<typeof testChatWiring>;
  let events: ChatEvents;
  let said: MessageSaid[];

  beforeEach(() => {
    testDb = createTestDb();
    wiring = testChatWiring(testDb.db);
    events = new ChatEvents();
    said = [];
    events.subscribe(async (event) => {
      if (event.type === "MessageSaid") said.push(event);
    });
  });
  afterEach(() => testDb.close());

  const recording = (channels: Channel[], listens?: (connectionId: string) => boolean) =>
    inboundRecording(
      {
        chats: wiring.chats,
        messages: wiring.messages,
        events,
        adapters: wiring.adapters,
        ...(listens ? { listens } : {}),
      },
      channels,
    );

  const chatOf = (address: string) =>
    wiring.chats.byKey(wiring.adapters.chatAt("telegram", address, "group"));
  const transcript = (address: string, threadId?: string) => {
    const chat = chatOf(address);
    return chat
      ? wiring.messages
          .read(placeIn(chat.ref, threadId as ChatId | undefined))
          .messages.map((m) => [platformId(m.key), m.body.text, m.saidBy?.name])
      : [];
  };

  it("records a message in its chat before a listener hears it", async () => {
    const telegram = fakeChannel("telegram");
    recording([telegram.channel]).listen();
    let onRecordWhenHeard: unknown;
    events.subscribe(async (event) => {
      if (event.type === "MessageSaid") onRecordWhenHeard = transcript(GROUP);
    });

    await telegram.deliver(message());

    expect(onRecordWhenHeard).toEqual([["tg-1", "Hello", "Alice"]]);
    expect(chatOf(GROUP)).toMatchObject({ key: "-100", kind: "group", name: "Team" });
    expect(said).toHaveLength(1);
    expect(said[0]).toMatchObject({
      message: { id: expect.any(Number), key: "rome-bot:tg-1", direction: "toRome" },
      via: { channel: "telegram" },
    });
  });

  it("records nothing until someone listens", async () => {
    const telegram = fakeChannel("telegram");
    recording([telegram.channel]);

    await telegram.deliver(message());

    expect(telegram.handlers).toHaveLength(0);
    expect(chatOf(GROUP)).toBeNull();
  });

  it("records a redelivery once, and it is heard once", async () => {
    const telegram = fakeChannel("telegram");
    recording([telegram.channel]).listen();

    await telegram.deliver(message());
    await telegram.deliver(message());

    expect(transcript(GROUP)).toHaveLength(1);
    expect(said).toHaveLength(1);
  });

  it("records a message said in a thread in the thread, under its chat", async () => {
    const telegram = fakeChannel("telegram");
    recording([telegram.channel]).listen();

    await telegram.deliver(
      message({ chatId: "-100:9" as ChatId, parentChatId: GROUP, messageId: "tg-2" }),
    );

    expect(transcript(GROUP)).toEqual([]);
    expect(said[0]?.message.place.chat).toEqual(chatOf(GROUP)?.ref);
    expect(said[0]?.message.place.threadId).toBeDefined();
  });

  it("records nothing that reaches an account Rome does not listen to", async () => {
    const telegram = fakeChannel("telegram");
    recording([telegram.channel], () => false).listen();

    await telegram.deliver(message());

    expect(chatOf(GROUP)).toBeNull();
    expect(said).toEqual([]);
  });

  it("records a channel added later once recording has started", async () => {
    const telegram = fakeChannel("telegram");
    const inbound = recording([]);
    inbound.listen();
    inbound.addChannels([telegram.channel]);

    await telegram.deliver(message());

    expect(transcript(GROUP)).toHaveLength(1);
  });

  it("stops recording when the last listener leaves", async () => {
    const telegram = fakeChannel("telegram");
    const inbound = recording([telegram.channel]);
    const first = inbound.listen();
    const second = inbound.listen();

    first();
    await telegram.deliver(message({ messageId: "tg-1" }));
    second();
    await telegram.deliver(message({ messageId: "tg-2" }));

    expect(transcript(GROUP).map(([id]) => id)).toEqual(["tg-1"]);
  });

  it("keeps a chat's order", async () => {
    const telegram = fakeChannel("telegram");
    recording([telegram.channel]).listen();

    await Promise.all([
      telegram.deliver(message({ messageId: "tg-1", text: "one" })),
      telegram.deliver(message({ messageId: "tg-2", text: "two" })),
    ]);

    expect(said.map((event) => platformId(event.message.key))).toEqual(["tg-1", "tg-2"]);
  });
});
