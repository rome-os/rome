import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import type {
  Account,
  Channel,
  ChannelMessage,
  ChatId,
  InboundEvent,
  OutgoingMessage,
} from "@rome-os/app-runtime";
import { ChatBuffers } from "../channels/conversation-buffer.js";
import { Pacer } from "../channels/delivery/pacer.js";
import { type DeliveryTransport, plainText } from "../channels/delivery/types.js";
import { systemClock } from "../lib/clock.js";
import { createTestDb, type TestDb } from "../test/helpers.js";
import { ChatAddresses } from "./chat-addresses.js";
import {
  addressOf,
  ChatAdapters,
  chatAt,
  channelAdapter,
  type Inbound,
  isDirectMessage,
  lineAt,
  platformIdOfLine,
  sentLineId,
} from "./chat-adapter.js";
import { chatKey } from "./chat-ids.js";

const ROME: Account = { platform: "telegram", id: "rome_bot" };
const OPEN_BUDGET = { burst: 1000, refillMs: 1, conversationSpacingMs: 0 };

/** A Telegram channel that hands each event to its subscriber and keeps what
 *  it was asked to send. */
function fakeChannel(transport?: DeliveryTransport) {
  let handler: ((event: InboundEvent) => Promise<void>) | null = null;
  const sent: Array<{ to: ChatId; message: OutgoingMessage }> = [];
  const channel = {
    name: "telegram",
    send: {
      send: async (to: ChatId, message: OutgoingMessage) => {
        sent.push({ to, message });
        return { messageId: `p${sent.length}`, chatId: to };
      },
      ...(transport ? { replies: { transport, pacer: new Pacer(OPEN_BUDGET, systemClock) } } : {}),
    },
    inbound: {
      subscribe(next: (event: InboundEvent) => Promise<void>) {
        handler = next;
        return () => {
          handler = null;
        };
      },
      media: null,
    },
  } as unknown as Channel;
  const hear = (
    message: Partial<Omit<ChannelMessage, "chatId">> & { chatId: string; messageId: string },
  ) => {
    if (!handler) throw new Error("nothing is listening");
    return handler({
      kind: "message",
      ref: { connectionId: "conn-1", chatId: message.chatId as ChatId },
      message: {
        channel: "telegram",
        direction: "inbound",
        senderId: "alice",
        senderDisplayName: "Alice",
        text: "hi",
        attachments: [],
        timestamp: new Date("2026-10-29T01:00:00Z"),
        ...message,
        chatId: message.chatId as ChatId,
      },
    });
  };
  return { channel, sent, hear, listening: () => handler !== null };
}

describe("chat adapter keys", () => {
  it("key a direct message by both its ends, and reach it at the other end", () => {
    const dm = chatAt("telegram", "alice", { romeEnd: "rome_bot" });
    expect(isDirectMessage(dm)).toBe(true);
    expect(addressOf(dm)).toBe("alice");
    expect(addressOf(dm, "topic-1" as ChatId)).toBe("topic-1");

    const group = chatAt("telegram", "-1001234567890123");
    expect(isDirectMessage(group)).toBe(false);
    expect(addressOf(group)).toBe("-1001234567890123");
  });

  it("key a basic group's lines by the account that heard them, and back", () => {
    const basic = chatAt("telegram", "-42");
    expect(lineAt(basic, "rome_bot", "7")).toBe("rome_bot:7");
    expect(platformIdOfLine(basic, "rome_bot", "rome_bot:7")).toBe("7");
    expect(sentLineId(basic, "rome_bot", "8")).toBe("rome_bot:8");
  });

  it("quote no line in a basic group that only another of Rome's accounts holds", () => {
    const basic = chatAt("telegram", "-42");
    expect(platformIdOfLine(basic, "rome_bot", "other_bot:7")).toBeNull();
    expect(platformIdOfLine(basic, "rome_bot", "7")).toBeNull();
    const group = chatAt("telegram", "-1001234567890123");
    expect(platformIdOfLine(group, "rome_bot", "7")).toBe("7");
  });

  it("key a line the platform gave no id by one of Rome's, which names no platform line", () => {
    const group = chatAt("telegram", "-1001234567890123");
    const key = sentLineId(group, "rome_bot", undefined);
    expect(key).toMatch(/^rome:/);
    expect(platformIdOfLine(group, "rome_bot", key)).toBeNull();
  });
});

describe("channelAdapter", () => {
  let testDb: TestDb;
  let addresses: ChatAddresses;
  const deps = () => ({
    accountOf: () => ROME,
    platformOfChannel: () => "telegram",
    addresses,
  });

  beforeEach(() => {
    testDb = createTestDb();
    addresses = new ChatAddresses(testDb.db);
  });
  afterEach(() => testDb.close());

  it("hand a group message to Chats by the adapter's keys, with the event while it is delivered", async () => {
    const { channel, hear } = fakeChannel();
    const adapter = channelAdapter(channel, deps());
    const delivered: Inbound[] = [];
    let event: InboundEvent | undefined;
    adapter.start(
      async (message) => {
        delivered.push(message);
        event = adapter.heard(message.chat.externalId, message.key);
        return 1;
      },
      (error) => {
        throw error;
      },
    );

    await hear({ chatId: "-42", messageId: "7", replyTo: { messageId: "6" } });
    await adapter.settled();

    expect(delivered).toEqual([
      expect.objectContaining({
        chat: chatKey("telegram", "-42" as ChatId),
        chatKind: "group",
        thread: null,
        key: "rome_bot:7",
        replyTo: "rome_bot:6",
        sender: { accountId: "alice", name: "Alice" },
        text: "hi",
        via: expect.objectContaining({ connectionId: "conn-1", address: "-42", account: ROME }),
      }),
    ]);
    expect(event?.message.messageId).toBe("7");
    expect(adapter.heard("-42", "rome_bot:7")).toBeUndefined();
  });

  it("hand a chat's messages over one at a time, its threads' too, holding none at the port", async () => {
    const { channel, hear } = fakeChannel();
    const adapter = channelAdapter(channel, deps());
    const order: string[] = [];
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let otherChatDone!: () => void;
    const otherChat = new Promise<void>((resolve) => {
      otherChatDone = resolve;
    });
    adapter.start(
      async (message) => {
        order.push(`start ${message.key}`);
        if (message.key === "1") await held;
        order.push(`end ${message.key}`);
        if (message.key === "4") otherChatDone();
        return 1;
      },
      () => {},
    );
    // The port buffers each platform address and holds its next event until
    // the handler returns, as connection ports do.
    const port = new ChatBuffers<{ chatId: string; messageId: string; parentChatId?: ChatId }>(
      (message) =>
        hear({
          ...message,
          ...(message.parentChatId ? { thread: { kind: "topic" as const } } : {}),
        }),
      { log: { warn: () => {}, error: () => {} }, describe: () => ({}) },
    );
    const thread = (chatId: string, messageId: string) =>
      port.push(chatId, { chatId, parentChatId: "-1001234567890123" as ChatId, messageId });

    // 1 and 2 in one thread, 3 in a sibling thread, 4 in another chat. The
    // adapter takes each from the port at once, so while 1 is being
    // delivered nothing waits at the port, 2 and 3 wait their turn in the
    // chat, and 4 goes ahead.
    thread("topic-1", "1");
    thread("topic-1", "2");
    thread("topic-2", "3");
    port.push("-1009999999999999", { chatId: "-1009999999999999", messageId: "4" });
    await otherChat;
    // Whatever the port could hand over by now, it has.
    await new Promise((resolve) => setImmediate(resolve));
    expect(port.size).toBe(0);
    expect(order).toEqual(["start 1", "start 4", "end 4"]);

    release();
    await adapter.settled();
    const rest = order.slice(3);
    expect(rest[0]).toBe("end 1");
    // One at a time, each thread's in the order heard.
    expect([rest.slice(1, 3), rest.slice(3, 5)].sort()).toEqual([
      ["start 2", "end 2"],
      ["start 3", "end 3"],
    ]);
  });

  it("hold at most a port's worth of a chat's messages while one is delivered, dropping the oldest", async () => {
    const { channel, hear } = fakeChannel();
    const adapter = channelAdapter(channel, deps());
    const delivered: string[] = [];
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    adapter.start(
      async (message) => {
        delivered.push(message.key);
        if (message.key === "1") await held;
        return 1;
      },
      () => {},
    );

    for (let id = 1; id <= 151; id += 1) {
      await hear({ chatId: "-1001234567890123", messageId: String(id) });
    }
    release();
    await adapter.settled();

    expect(delivered).toHaveLength(101);
    expect(delivered.slice(0, 3)).toEqual(["1", "52", "53"]);
    expect(delivered.at(-1)).toBe("151");
  });

  it("hold no event for a message whose address could not be kept", async () => {
    const { channel, hear } = fakeChannel();
    const failing = {
      ...deps(),
      addresses: {
        ...addresses,
        bind: () => {
          throw new Error("store down");
        },
        addressOf: () => null,
        keyAt: () => null,
        bindThread: () => {},
        threadChatAt: () => null,
      },
    };
    const adapter = channelAdapter(channel, failing);
    const faults: Error[] = [];
    adapter.start(
      async () => 1,
      (error) => faults.push(error),
    );

    await hear({ chatId: "alice", messageId: "3", thread: { kind: "dm" } });
    await adapter.settled();
    expect(faults.map((error) => error.message)).toEqual(["store down"]);
    expect(adapter.heard("dm:rome_bot:alice", "3")).toBeUndefined();
  });

  it("hand nothing for a message with no text and no attachments", async () => {
    const { channel, hear } = fakeChannel();
    const adapter = channelAdapter(channel, deps());
    const delivered: Inbound[] = [];
    adapter.start(
      async (message) => {
        delivered.push(message);
        return null;
      },
      () => {},
    );

    await hear({ chatId: "-42", messageId: "7", text: "  " });
    await adapter.settled();
    expect(delivered).toEqual([]);
  });

  it("key a thread's message by its parent chat, and reach the thread at its own address", async () => {
    const { channel, hear } = fakeChannel();
    const adapter = channelAdapter(channel, deps());
    const delivered: Inbound[] = [];
    adapter.start(
      async (message) => {
        delivered.push(message);
        return 1;
      },
      () => {},
    );

    await hear({
      chatId: "topic-1",
      parentChatId: "-1001234567890123" as ChatId,
      messageId: "9",
      thread: { kind: "topic", name: "Plans" },
    });
    await adapter.settled();

    expect(delivered[0]).toMatchObject({
      chat: { externalId: "-1001234567890123" },
      thread: { id: "topic-1", name: "Plans" },
      chatName: null,
    });
    expect(adapter.threadAt("topic-1")).toEqual(chatKey("telegram", "-1001234567890123" as ChatId));
    expect(adapter.threadAt("topic-2")).toBeNull();
  });

  it("send to a direct message where it was heard, quoting the platform's id", async () => {
    const { channel, hear, sent } = fakeChannel();
    const adapter = channelAdapter(channel, deps());
    const delivered: Inbound[] = [];
    adapter.start(
      async (message) => {
        delivered.push(message);
        return 1;
      },
      () => {},
    );
    await hear({ chatId: "alice", messageId: "3", thread: { kind: "dm" } });
    await adapter.settled();
    const dm = delivered[0]!;
    expect(dm.chatKind).toBe("dm");

    const landed = await adapter.send(dm.chat.externalId, null, {
      text: "hello",
      replyTo: dm.key,
    });

    expect(sent).toEqual([{ to: "alice", message: { text: "hello", replyToMessageId: "3" } }]);
    expect(landed).toEqual({ key: "p1", threadId: null });
  });

  it("answer the thread a sent message landed in when the platform placed it elsewhere", async () => {
    const { channel } = fakeChannel();
    (channel.send as { send: unknown }).send = async () => ({
      messageId: "m9",
      chatId: "thread-7",
    });
    const adapter = channelAdapter(channel, deps());

    const landed = await adapter.send("-1001234567890123", null, { text: "on it" });

    expect(landed).toEqual({ key: "m9", threadId: "thread-7" });
    // A send to the thread finds its chat before anything is heard there.
    expect(adapter.threadAt("thread-7")?.externalId).toBe("-1001234567890123");
  });

  it("stop delivering once stopped, and refuse a second start while receiving", async () => {
    const { channel, listening } = fakeChannel();
    const adapter = channelAdapter(channel, deps());
    adapter.start(
      async () => null,
      () => {},
    );
    expect(() =>
      adapter.start(
        async () => null,
        () => {},
      ),
    ).toThrow("already receiving");

    await adapter.stop();
    expect(listening()).toBe(false);
  });

  it("open no stream on a channel that cannot stream", () => {
    const { channel } = fakeChannel();
    const adapter = channelAdapter(channel, deps());
    expect(
      adapter.stream?.("-42", null, {
        policy: { mode: "final", editIntervalMs: 0, blockWaitMs: 0, maxPendingChars: 10_000 },
        clock: systemClock,
      }),
    ).toBeNull();
  });

  it("settle a streamed reply to the text shown and its first message's key, as the account holds it", async () => {
    const created: string[] = [];
    const transport: DeliveryTransport = {
      capabilities: { maxPartLength: 4000, edit: false, budget: OPEN_BUDGET },
      codec: plainText,
      create: async (conversation, text) => {
        created.push(text);
        return { messageId: `s${created.length}`, chatId: conversation };
      },
    };
    const { channel } = fakeChannel(transport);
    const adapter = channelAdapter(channel, deps());
    const reply = adapter.stream?.("-42", null, {
      policy: { mode: "final", editIntervalMs: 0, blockWaitMs: 0, maxPendingChars: 10_000 },
      clock: systemClock,
    });
    if (!reply) throw new Error("expected a stream");

    reply.accept({ type: "text", content: "All done." });
    const settled = await reply.settle(false);

    expect(created).toEqual(["All done."]);
    expect(settled).toMatchObject({ text: "All done.", key: "rome_bot:s1", threadId: null });
  });

  it("open no thread with a first direct message, and reach the chat where it opened", async () => {
    const { channel } = fakeChannel();
    (channel.send as { send: unknown }).send = async () => ({ messageId: "m1", chatId: "dm-77" });
    const adapter = channelAdapter(channel, deps());
    const dm = chatAt("telegram", "alice", { romeEnd: "rome_bot" });

    const landed = await adapter.send(dm.externalId, null, { text: "hi" });

    expect(landed.threadId).toBeNull();
    expect(addresses.addressOf(ROME, dm.externalId)).toBe("dm-77");
  });

  it("answer a sent direct message even when its new address cannot be kept", async () => {
    const { channel } = fakeChannel();
    (channel.send as { send: unknown }).send = async () => ({ messageId: "m1", chatId: "dm-77" });
    const broken = {
      ...deps(),
      addresses: Object.assign(Object.create(addresses), {
        bind: () => {
          throw new Error("disk full");
        },
      }),
    };
    const dm = chatAt("telegram", "alice", { romeEnd: "rome_bot" });

    const sentTo = await channelAdapter(channel, broken).send(dm.externalId, null, { text: "hi" });
    expect(sentTo).toEqual({ key: "m1", threadId: null });

    const transport: DeliveryTransport = {
      capabilities: { maxPartLength: 4000, edit: false, budget: OPEN_BUDGET },
      codec: plainText,
      create: async () => ({ messageId: "s1", chatId: "dm-78" }),
    };
    const reply = channelAdapter(fakeChannel(transport).channel, broken).stream?.(
      dm.externalId,
      null,
      {
        policy: { mode: "final", editIntervalMs: 0, blockWaitMs: 0, maxPendingChars: 10_000 },
        clock: systemClock,
      },
    );
    if (!reply) throw new Error("expected a stream");
    reply.accept({ type: "text", content: "hi" });
    expect(await reply.settle(false)).toMatchObject({ key: "s1", threadId: null });
  });

  it("settle a first streamed direct message to no thread, and reach the chat where it opened", async () => {
    const transport: DeliveryTransport = {
      capabilities: { maxPartLength: 4000, edit: false, budget: OPEN_BUDGET },
      codec: plainText,
      create: async () => ({ messageId: "s1", chatId: "dm-78" }),
    };
    const { channel } = fakeChannel(transport);
    const adapter = channelAdapter(channel, deps());
    const dm = chatAt("telegram", "alice", { romeEnd: "rome_bot" });
    const reply = adapter.stream?.(dm.externalId, null, {
      policy: { mode: "final", editIntervalMs: 0, blockWaitMs: 0, maxPendingChars: 10_000 },
      clock: systemClock,
    });
    if (!reply) throw new Error("expected a stream");

    reply.accept({ type: "text", content: "hi" });

    expect(await reply.settle(false)).toMatchObject({ threadId: null });
    expect(addresses.addressOf(ROME, dm.externalId)).toBe("dm-78");
  });

  it("settle a streamed reply to the thread its first message landed in", async () => {
    const transport: DeliveryTransport = {
      capabilities: { maxPartLength: 4000, edit: false, budget: OPEN_BUDGET },
      codec: plainText,
      create: async () => ({ messageId: "s1", chatId: "thread-8" }),
    };
    const { channel } = fakeChannel(transport);
    const adapter = channelAdapter(channel, deps());
    const reply = adapter.stream?.("-1001234567890123", null, {
      policy: { mode: "final", editIntervalMs: 0, blockWaitMs: 0, maxPendingChars: 10_000 },
      clock: systemClock,
    });
    if (!reply) throw new Error("expected a stream");

    reply.accept({ type: "text", content: "All done." });

    expect(await reply.settle(false)).toMatchObject({ key: "s1", threadId: "thread-8" });
  });
});

describe("ChatAdapters", () => {
  let testDb: TestDb;
  let addresses: ChatAddresses;
  let adapters: ChatAdapters;

  beforeEach(() => {
    testDb = createTestDb();
    addresses = new ChatAddresses(testDb.db);
    adapters = new ChatAdapters({
      accountOf: (channel) => (channel === "telegram" ? ROME : null),
      platformOfChannel: () => "telegram",
      addresses,
      keyOf: () => chatKey("telegram", "-42" as ChatId),
      channelsOn: () => ["telegram", "telegram-user"],
    });
  });
  afterEach(() => testDb.close());

  it("build one adapter per channel, and a new one for a channel minted again", () => {
    const first = fakeChannel().channel;
    expect(adapters.of(first)).toBe(adapters.of(first));
    expect(adapters.of(fakeChannel().channel)).not.toBe(adapters.of(first));
  });

  it("name the account a channel is, and the channel an account is", () => {
    expect(adapters.accountOn("telegram")).toEqual(ROME);
    expect(adapters.accountOn("telegram-user")).toEqual({
      platform: "telegram",
      id: "telegram-user",
    });
    expect(adapters.channelOf(ROME)).toBe("telegram");
    expect(adapters.channelOf({ platform: "telegram", id: "nobody" })).toBeNull();
  });

  it("find a direct message at the address it was reached at, and reach it there", () => {
    const dm = adapters.directMessageReached("telegram", "alice", "dm-address-1");

    expect(adapters.chatAt("telegram", "dm-address-1", "dm")).toEqual(dm);
    expect(adapters.chatAt("telegram", "-42", "group")).toEqual(
      chatKey("telegram", "-42" as ChatId),
    );
    expect(adapters.chatAt("telegram", "bob", "dm")).toEqual(
      chatAt("telegram", "bob", { romeEnd: "rome_bot" }),
    );
  });
});
