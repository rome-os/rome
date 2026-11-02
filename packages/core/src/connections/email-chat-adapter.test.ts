import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import type { Account, Channel, ChatId, InboundEvent, OutgoingMessage } from "@rome-os/app-runtime";
import { createTestDb, type TestDb } from "../test/helpers.js";
import { ChatAddresses } from "./chat-addresses.js";
import { channelAdapter, type Inbound } from "./chat-adapter.js";
import { EMAIL_PLATFORM, emailChatAdapter, emailOf, isEmailAdapter } from "./email-chat-adapter.js";

const ROME: Account = { platform: EMAIL_PLATFORM, id: "rome@example.com" };

/** An email channel that names each new thread and keeps what it was asked
 *  to send. */
function fakeMail(
  receipt: { messageId?: string; chatId: string } = { messageId: "m1", chatId: "thread-1" },
) {
  let handler: ((event: InboundEvent) => Promise<void>) | null = null;
  const sent: Array<{ to: ChatId; message: OutgoingMessage }> = [];
  const channel = {
    name: "mail",
    send: {
      send: async (to: ChatId, message: OutgoingMessage) => {
        sent.push({ to, message });
        return receipt;
      },
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
  const hear = (chatId: string, messageId: string) => {
    if (!handler) throw new Error("nothing is listening");
    return handler({
      kind: "message",
      ref: { connectionId: "conn-1", chatId: chatId as ChatId },
      message: {
        channel: "mail",
        direction: "inbound",
        chatId: chatId as ChatId,
        messageId,
        senderId: "wei@example.com",
        senderDisplayName: "Wei",
        text: "thanks",
        attachments: [],
        timestamp: new Date("2026-10-29T01:00:00Z"),
        thread: { kind: "group" },
      },
    } as InboundEvent);
  };
  return { channel, sent, hear };
}

describe("emailChatAdapter", () => {
  let testDb: TestDb;
  let addresses: ChatAddresses;
  const deps = () => ({
    accountOf: () => ROME,
    platformOfChannel: () => "email",
    addresses,
  });

  beforeEach(() => {
    testDb = createTestDb();
    addresses = new ChatAddresses(testDb.db);
  });
  afterEach(() => testDb.close());

  it("start a thread Rome opens with its first message, and reply in the thread the provider named", async () => {
    const { channel, sent } = fakeMail();
    const adapter = emailChatAdapter(channel, deps());
    const chat = adapter.open({ to: "wei@example.com", cc: ["ann@example.com"] }, "Plans");

    expect(sent).toEqual([]);
    const first = await adapter.send(chat.externalId, null, {
      text: "hello",
      html: "<p>hello</p>",
    });

    expect(first).toEqual({ key: "m1", threadId: null });
    expect(sent[0]).toEqual({
      to: "",
      message: {
        kind: "email",
        text: "hello",
        html: "<p>hello</p>",
        to: "wei@example.com",
        cc: ["ann@example.com"],
        subject: "Plans",
      },
    });
    expect(addresses.addressOf(ROME, chat.externalId)).toBe("thread-1");

    await adapter.send(chat.externalId, null, { text: "again", replyTo: "m1" });
    expect(sent[1]).toEqual({
      to: "thread-1",
      message: { kind: "email", text: "again", inReplyToMessageId: "m1" },
    });
  });

  it("refuse a first message the provider named no thread for, and keep the thread unsent", async () => {
    const { channel, sent } = fakeMail({ messageId: "m1", chatId: " " });
    const adapter = emailChatAdapter(channel, deps());
    const chat = adapter.open({ to: "wei@example.com" }, "Plans");

    await expect(adapter.send(chat.externalId, null, { text: "hello" })).rejects.toThrow(
      "named no thread",
    );
    await expect(adapter.send(chat.externalId, null, { text: "hello" })).rejects.toThrow(
      "named no thread",
    );
    expect(sent.map((s) => s.to)).toEqual(["", ""]);
  });

  it("hear a reply in a thread Rome opened under the chat it opened", async () => {
    const { channel, hear } = fakeMail();
    const adapter = emailChatAdapter(channel, deps());
    const chat = adapter.open({ to: "wei@example.com" }, "Plans");
    await adapter.send(chat.externalId, null, { text: "hello" });
    const delivered: Inbound[] = [];
    adapter.start(
      async (message) => {
        delivered.push(message);
        return 1;
      },
      () => {},
    );

    await hear("thread-1", "m2");
    await adapter.settled();

    expect(delivered.map((message) => [message.chat.externalId, message.chatKind])).toEqual([
      [chat.externalId, "group"],
    ]);
  });

  it("tell the email adapter from another channel's", () => {
    const { channel } = fakeMail();
    expect(isEmailAdapter(emailChatAdapter(channel, deps()))).toBe(true);
    const plain = channelAdapter(channel, deps());
    expect(isEmailAdapter(plain)).toBe(false);
    expect(() => emailOf({ of: () => plain }, channel)).toThrow('Channel "mail" sends no email');
  });
});
