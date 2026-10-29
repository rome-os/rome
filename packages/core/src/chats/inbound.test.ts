import { beforeEach, describe, expect, it, rs } from "@rstest/core";
import type {
  Channel,
  ChannelInboundMedia,
  ChannelMessage,
  ChatId,
  InboundEvent,
  RecordedInboundEvent,
} from "@rome-os/app-runtime";
import { eq } from "drizzle-orm";
import { WebChatRepository } from "../db/repositories/webchat.js";
import { romeAgentMessages, romeSessions } from "../db/schema.js";
import { channelChatId } from "../db/session-kind.js";
import { createTestDb, type TestDb } from "../test/helpers.js";
import { ChatEvents } from "./events.js";
import { inboundRecording } from "./inbound.js";
import { StoredMessages } from "./message-repository.js";

// Recording what reaches Rome, then hearing it. What these pin: a message is
// on record in its chat before anything hears it, a redelivery is neither
// recorded nor heard twice, and nothing is recorded until a subscriber asks.

const GROUP = "tg-group-1" as ChatId;
const TOPIC = "tg-group-1:topic-9" as ChatId;

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

/** A channel whose deliveries the test drives, one chat at a time as R4 asks. */
function fakeChannel(name: string, media: ChannelInboundMedia | null = null) {
  const handlers: ((event: InboundEvent) => Promise<void>)[] = [];
  const channel: Channel = {
    name,
    send: null,
    inbound: {
      subscribe: (handler) => {
        handlers.push(handler);
        return () => handlers.splice(handlers.indexOf(handler), 1);
      },
      media,
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

describe("inboundRecording", () => {
  let testDb: TestDb;
  let rows: WebChatRepository;
  let events: ChatEvents;
  let messages: StoredMessages;

  beforeEach(() => {
    testDb = createTestDb();
    rows = new WebChatRepository(testDb.db);
    events = new ChatEvents();
    messages = new StoredMessages(rows, events, { channelsOn: () => ["telegram"] });
    rows.leaveOutOfCatchUp((id) => messages.isWakeUndecided(id));
  });

  const recording = (channels: Channel[], accountAgentOf?: () => string | null | undefined) =>
    inboundRecording(
      {
        chats: rows,
        messages,
        events,
        platformOfChannel: () => "telegram",
        ...(accountAgentOf ? { accountAgentOf } : {}),
      },
      channels,
    );

  const messagesIn = (chatId: ChatId) =>
    testDb.db
      .select()
      .from(romeAgentMessages)
      .where(eq(romeAgentMessages.sessionId, channelChatId("telegram", chatId)))
      .all();

  it("records a message in its chat before a subscriber hears it", async () => {
    const telegram = fakeChannel("telegram");
    const { recordedMessages } = recording([telegram.channel]);
    let rowsWhenHeard: unknown;
    const heard: RecordedInboundEvent[] = [];
    recordedMessages.subscribe(async (event) => {
      rowsWhenHeard = messagesIn(GROUP).map((row) => row.platformMessageId);
      heard.push(event);
    });

    await telegram.deliver(message());

    expect(rowsWhenHeard).toEqual(["tg-1"]);
    expect(messagesIn(GROUP)).toMatchObject([
      {
        role: "notification",
        senderId: "alice-tg",
        senderName: "Alice",
        content: JSON.stringify([{ type: "text", content: "Hello" }]),
      },
    ]);
    const [row] = messagesIn(GROUP);
    expect(heard).toHaveLength(1);
    expect(heard[0]).toMatchObject({
      message: { messageId: "tg-1", channel: "telegram" },
      ref: { connectionId: "connection:telegram", chatId: GROUP },
      recorded: { chatRecordId: channelChatId("telegram", GROUP), messageId: row?.id },
    });
  });

  it("records nothing until a subscriber subscribes", async () => {
    const telegram = fakeChannel("telegram");
    recording([telegram.channel]);

    await telegram.deliver(message());

    expect(telegram.handlers).toHaveLength(0);
    expect(messagesIn(GROUP)).toEqual([]);
  });

  it("records a redelivery once, and it is heard once", async () => {
    const telegram = fakeChannel("telegram");
    const { recordedMessages } = recording([telegram.channel]);
    const heard = rs.fn(async () => undefined);
    recordedMessages.subscribe(heard);

    await telegram.deliver(message());
    await telegram.deliver(message());

    expect(messagesIn(GROUP)).toHaveLength(1);
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it("records a message said in a thread in the thread, under its chat", async () => {
    const telegram = fakeChannel("telegram");
    recording([telegram.channel]).recordedMessages.subscribe(async () => undefined);

    await telegram.deliver(message({ chatId: TOPIC, parentChatId: GROUP }));

    expect(messagesIn(TOPIC)).toHaveLength(1);
    const thread = testDb.db
      .select()
      .from(romeSessions)
      .where(eq(romeSessions.id, channelChatId("telegram", TOPIC)))
      .get();
    expect(thread?.parentSessionId).toBe(channelChatId("telegram", GROUP));
  });

  it("records nothing that reaches an account with no agent", async () => {
    const telegram = fakeChannel("telegram");
    const heard = rs.fn(async () => undefined);
    recording([telegram.channel], () => null).recordedMessages.subscribe(heard);

    await telegram.deliver(message());

    expect(messagesIn(GROUP)).toEqual([]);
    expect(heard).not.toHaveBeenCalled();
  });

  it("saves attachments before recording, and hands on the saved ones", async () => {
    const saved = [{ type: "image" as const, fileName: "a.jpg", localPath: "/tmp/a.jpg" }];
    const materialize = rs.fn(async () => saved);
    const telegram = fakeChannel("telegram", { materialize });
    const heard: RecordedInboundEvent[] = [];
    recording([telegram.channel]).recordedMessages.subscribe(async (event) => {
      heard.push(event);
    });

    await telegram.deliver(message({ text: "", attachments: [{ type: "image", url: "file-1" }] }));

    expect(messagesIn(GROUP)[0]?.content).toBe(
      JSON.stringify([{ type: "text", content: "Attachment 1 (image a.jpg) path: /tmp/a.jpg" }]),
    );
    expect(heard[0]?.message.attachments).toEqual(saved);
  });

  it("records a channel added later once recording has started", async () => {
    const telegram = fakeChannel("telegram");
    const second = fakeChannel("telegram-2");
    const recorder = recording([telegram.channel]);
    recorder.addChannels([second.channel]);
    expect(second.handlers).toHaveLength(0);

    recorder.recordedMessages.subscribe(async () => undefined);
    const third = fakeChannel("telegram-3");
    recorder.addChannels([third.channel]);

    expect(second.handlers).toHaveLength(1);
    expect(third.handlers).toHaveLength(1);
    expect(telegram.handlers).toHaveLength(1);
  });

  it("keeps a message out of other turns' catch-up until its wake is decided", async () => {
    const telegram = fakeChannel("telegram");
    const recorder = recording([telegram.channel]);
    const heard: RecordedInboundEvent[] = [];
    recorder.recordedMessages.subscribe(async (event) => {
      heard.push(event);
    });
    const chat = channelChatId("telegram", GROUP);
    const catchUp = async () =>
      (await rows.loadConversationContext(chat)).unseen.map((message) => message.id);

    await telegram.deliver(message({ messageId: "tg-a" }));
    await telegram.deliver(message({ messageId: "tg-b" }));
    const [a, b] = heard.map((event) => event.recorded);
    // A turn starting now, such as the one message A woke, sees neither.
    expect(await catchUp()).toEqual([]);

    // A woke an agent: it is that turn's prompt, never catch-up.
    await rows.promoteConversationMessageToUser(chat, "tg-a");
    await recorder.recordedMessages.decided(a!);
    expect(await catchUp()).toEqual([]);

    // B woke none: once decided, the next turn catches up on it.
    await recorder.recordedMessages.decided(b!);
    expect(await catchUp()).toEqual([b!.messageId]);
  });

  it("decides the wake of a message nobody hears, so it is not left out for good", async () => {
    const telegram = fakeChannel("telegram");
    const recorder = recording([telegram.channel]);
    const leave = recorder.recordedMessages.subscribe(async () => undefined);
    leave();

    await telegram.deliver(message());

    const chat = channelChatId("telegram", GROUP);
    expect((await rows.loadConversationContext(chat)).unseen).toHaveLength(1);
  });

  it("refuses to record into a chat that does not exist", async () => {
    await expect(
      messages.record(
        {
          direction: "toRome",
          place: { chat: { platform: "telegram", id: GROUP } },
          saidBy: { account: { platform: "telegram", id: "alice-tg" } },
          body: { text: "Hello" },
          platformMessageId: "tg-1",
          at: new Date(),
        },
        { channel: "telegram" },
      ),
    ).rejects.toThrow("No chat at telegram:tg-group-1");
  });
});
