// An app's writes to the chats its sessions stand in, kept in Chats.

import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import type { Channel, ChatId, ChatRecord, OutgoingMessage } from "@rome-os/app-runtime";
import { sql } from "drizzle-orm";
import { ChatRepository } from "../chats/storage/chat-repository.js";
import { MessageRepository } from "../chats/storage/message-repository.js";
import { placeIn, type ChatRef } from "../chats/storage/place.js";
import { ChatAddresses } from "../connections/chat-addresses.js";
import type { ChannelChatAdapter, Outbound } from "../connections/chat-adapter.js";
import { chatKey } from "../connections/chat-ids.js";
import { emailChatAdapter } from "../connections/email-chat-adapter.js";
import { SpeakerLines } from "../connections/speaker-lines.js";
import { WebChatRepository } from "../db/repositories/webchat.js";
import { SpeakerReplies } from "../sessions/speaker-replies.js";
import { Speakers } from "../sessions/speakers.js";
import { TurnLinks } from "../sessions/turn-links.js";
import { createTestDb, type TestDb } from "../test/helpers.js";
import { speakerFixture } from "../test/speakers.js";
import { appChatWrites, type ChatWrites } from "./chat-writes.js";

const BOT = { platform: "telegram", id: "rome_bot" };
const TELEGRAM = { name: "telegram" } as Channel;

describe("appChatWrites", () => {
  let testDb: TestDb;
  let fixture: ReturnType<typeof speakerFixture>;
  let messages: MessageRepository;
  let links: TurnLinks;
  let lines: SpeakerLines;
  let group: ChatRef;
  let sends: Array<{ chat: string; threadId: ChatId | null; out: Outbound }>;
  let refuse: boolean;
  let writes: ChatWrites;
  let opened: string[];
  let email: ChannelChatAdapter | null;
  let mailSent: Array<{ to: ChatId; message: OutgoingMessage }>;

  const telegram = {
    account: BOT,
    async send(chat: string, threadId: ChatId | null, out: Outbound) {
      if (refuse) throw new Error("refused");
      sends.push({ chat, threadId, out });
      // Keyed as Rome's account holds the platform's id for it.
      return { key: lines.keyIn(speakerAt(), `${100 + sends.length}`), threadId };
    },
  } as unknown as ChannelChatAdapter;

  const mail = {
    name: "mail",
    send: {
      send: async (to: ChatId, message: OutgoingMessage) => {
        mailSent.push({ to, message });
        return { messageId: `m${mailSent.length}`, chatId: "thread-1" };
      },
    },
  } as unknown as Channel;

  beforeEach(() => {
    testDb = createTestDb();
    fixture = speakerFixture(testDb.db);
    messages = new MessageRepository(testDb.db);
    links = new TurnLinks(testDb.db, messages);
    const chats = new ChatRepository(testDb.db);
    const speakers = new Speakers(testDb.db);
    const keyOf = (ref: ChatRef) => {
      const chat = chats.get(ref);
      if (!chat) throw new Error(`No chat ${ref.id}`);
      return chatKey(ref.platform, chat.key as ChatId);
    };
    const addresses = new ChatAddresses(testDb.db);
    email = null;
    const adapterOf = (channel: Channel) => {
      if (channel !== mail) return telegram;
      email ??= emailChatAdapter(mail, {
        accountOf: () => ({ platform: "email", id: "rome@example.com" }),
        platformOfChannel: () => "email",
        addresses,
      });
      return email;
    };
    lines = new SpeakerLines({ speakers, messages, adapters: { keyOf } });
    group = fixture.chat("telegram", "-100", "group", "ops");
    fixture.speaker({ id: "s1", chat: group, accountId: BOT.id });
    sends = [];
    refuse = false;
    opened = [];
    mailSent = [];
    writes = appChatWrites({
      webchatRepo: new WebChatRepository(testDb.db),
      chats,
      messages,
      speakers,
      replies: new SpeakerReplies({
        speakers,
        adapters: { of: adapterOf, keyOf },
        messages,
        links,
      }),
      links,
      lines,
      adapters: {
        of: adapterOf,
        addressAt: (_channel, place) => (place.threadId ?? "thread-1") as ChatId,
      },
      channel: (name) => (name === "mail" ? mail : name === "telegram" ? TELEGRAM : null),
      open: async (input) => {
        opened.push(input.threadId);
        const [chat] = testDb.db.all<{ id: number }>(
          sql`SELECT id FROM chats WHERE platform = 'email' ORDER BY id DESC LIMIT 1`,
        );
        const id = `mail-${opened.length}`;
        fixture.speaker({
          id,
          chat: { platform: "email", id: chat!.id },
          accountId: "rome@example.com",
        });
        return { id } as ChatRecord;
      },
    });
  });
  afterEach(() => testDb.close());

  const said = () =>
    testDb.db.all<{ id: number; key: string; text: string; parts: string }>(
      sql`SELECT id, key, text, parts FROM chat_messages ORDER BY id`,
    );
  const linkOf = (sessionId: string, id: number) => links.linkOf(sessionId, id);
  const speakerAt = () => ({ place: placeIn(group), accountId: BOT.id });

  describe("addMessage", () => {
    it("records a line keyed as its account hears it, as the session's prompt, once", async () => {
      const input = {
        sessionId: "s1",
        role: "user" as const,
        content: JSON.stringify([{ type: "text", content: "hello" }]),
        platformMessageId: "41",
        senderId: "wei",
        senderName: "Wei",
      };

      expect(await writes.addMessage(input)).toEqual({ inserted: true });
      expect(await writes.addMessage(input)).toEqual({ inserted: false });

      const [line] = said();
      expect(line).toMatchObject({ key: lines.keyIn(speakerAt(), "41"), text: "hello" });
      expect(linkOf("s1", line!.id)).toMatchObject({ role: "prompt" });
    });

    it("keeps a notification out of the turn until it is promoted", async () => {
      await writes.addMessage({
        sessionId: "s1",
        role: "notification",
        content: JSON.stringify([{ type: "text", content: "fyi" }]),
        platformMessageId: "42",
      });
      const [line] = said();
      expect(linkOf("s1", line!.id)).toBeNull();

      await writes.promoteMessageToUser("s1", "42");

      expect(linkOf("s1", line!.id)).toMatchObject({ role: "prompt" });
    });

    it("refuses a session that stands in no chat", async () => {
      await expect(
        writes.addMessage({
          sessionId: "nowhere",
          role: "user",
          content: "[]",
          platformMessageId: "1",
        }),
      ).rejects.toThrow("stands in no chat");
    });
  });

  describe("send", () => {
    it("sends through the session's adapter, records it as the turn's answer, and answers the platform's id", async () => {
      const result = await writes.send({
        sessionId: "s1",
        channel: "telegram",
        text: "Deploy done",
        turnId: "turn-1",
        knownToProvider: true,
      });

      expect(sends).toEqual([
        { chat: "-100", threadId: null, out: { text: "Deploy done", turnId: "turn-1" } },
      ]);
      const [line] = said();
      expect(line).toMatchObject({ key: lines.keyIn(speakerAt(), "101"), text: "Deploy done" });
      expect(linkOf("s1", line!.id)).toMatchObject({ role: "answer", turnId: "turn-1" });
      expect(result).toEqual({ messageId: "101" });
    });

    it("quotes a line by the platform's id, records what the app hands over, and keeps host-only parts out", async () => {
      await writes.addMessage({
        sessionId: "s1",
        role: "user",
        content: "[]",
        platformMessageId: "41",
      });
      const card = { type: "routine_draft_card", draft: {} } as never;

      await writes.send({
        sessionId: "s1",
        channel: "telegram",
        text: "Sure",
        parts: [{ type: "text", content: "Sure" }, card],
        content: JSON.stringify([{ type: "text", content: "Sure, on record" }, card]),
        replyToPlatformMessageId: "41",
        knownToProvider: false,
      });

      expect(sends[0]?.out).toEqual({
        text: "Sure",
        parts: [{ type: "text", content: "Sure" }],
        replyTo: lines.keyIn(speakerAt(), "41"),
      });
      expect(JSON.parse(said().at(-1)!.parts)).toEqual([
        { type: "text", content: "Sure, on record" },
      ]);
    });

    it("records nothing when the platform refuses", async () => {
      refuse = true;

      await expect(
        writes.send({ sessionId: "s1", channel: "telegram", text: "x", knownToProvider: false }),
      ).rejects.toThrow("refused");
      expect(said()).toEqual([]);
    });

    it("refuses a channel Rome holds none by", async () => {
      await expect(
        writes.send({ sessionId: "s1", channel: "nope", text: "x", knownToProvider: false }),
      ).rejects.toThrow('No channel named "nope"');
    });
  });

  describe("sendEmail", () => {
    it("starts a thread with its first message, then joins main there once the provider took it", async () => {
      const result = await writes.sendEmail({
        channel: "mail",
        text: "Plans",
        email: { to: "wei@example.com", subject: "Plans" },
        turnId: "turn-1",
        knownToProvider: true,
      });

      expect(mailSent[0]?.message).toMatchObject({ to: "wei@example.com", subject: "Plans" });
      expect(opened).toEqual(["thread-1"]);
      const [line] = said();
      expect(line).toMatchObject({ text: "Plans" });
      expect(linkOf("mail-1", line!.id)).toMatchObject({ role: "answer", turnId: "turn-1" });
      expect(result).toEqual({ messageId: "m1", threadId: "thread-1" });
    });

    it("refuses a blank message to reply to before anything goes out", async () => {
      await expect(
        writes.sendEmail({
          channel: "mail",
          threadId: "thread-1",
          text: "x",
          email: { inReplyToMessageId: " " },
          knownToProvider: false,
        }),
      ).rejects.toThrow("must not be blank");
      expect(mailSent).toEqual([]);
    });
  });
});
