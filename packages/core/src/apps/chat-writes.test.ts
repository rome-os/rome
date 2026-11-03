// An app's writes to the chats its sessions stand in, kept in Chats.

import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import type { Channel, ChatId, ChatRecord, OutgoingMessage } from "@rome-os/app-runtime";
import { sql } from "drizzle-orm";
import { actionExecutionContext } from "../actions/context.js";
import { ChatRepository } from "../chats/storage/chat-repository.js";
import { MessageRepository } from "../chats/storage/message-repository.js";
import { placeIn, type ChatRef } from "../chats/storage/place.js";
import { ChatAddresses } from "../connections/chat-addresses.js";
import type { ChannelChatAdapter, Outbound } from "../connections/chat-adapter.js";
import { chatKey } from "../connections/chat-ids.js";
import { emailChatAdapter } from "../connections/email-chat-adapter.js";
import { SpeakerMessages } from "../connections/speaker-messages.js";
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
  let lines: SpeakerMessages;
  let group: ChatRef;
  let sends: Array<{ chat: string; threadId: ChatId | null; out: Outbound }>;
  let refuse: boolean;
  let writes: ChatWrites;
  let opened: string[];
  let email: ChannelChatAdapter | null;
  let mailSent: Array<{ to: ChatId; message: OutgoingMessage }>;
  let failOpen: boolean;
  let failBind: boolean;
  // Storage that fails once the platform took a message.
  let failKeys: boolean;
  let failKeysOnSend: boolean;
  let threads: number;

  const telegram = {
    account: BOT,
    async send(chat: string, threadId: ChatId | null, out: Outbound) {
      if (refuse) throw new Error("refused");
      sends.push({ chat, threadId, out });
      // Keyed as Rome's account holds the platform's id for it.
      const key = lines.keyIn(speakerAt(), `${100 + sends.length}`);
      failKeysOnSend && (failKeys = true);
      return { key, threadId };
    },
  } as unknown as ChannelChatAdapter;

  const mail = {
    name: "mail",
    send: {
      send: async (to: ChatId, message: OutgoingMessage) => {
        mailSent.push({ to, message });
        // A new email starts a thread of its own; a reply lands in its own.
        const chatId = to.startsWith("thread-") ? to : `thread-${(threads += 1)}`;
        failKeysOnSend && (failKeys = true);
        return { messageId: `m${mailSent.length}`, chatId };
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
    const stored = new ChatAddresses(testDb.db);
    // Storing a thread's address can fail after the provider took its email.
    const addresses = Object.assign(Object.create(stored) as ChatAddresses, {
      bind: (...args: Parameters<ChatAddresses["bind"]>) => {
        if (failBind) throw new Error("store unavailable");
        return stored.bind(...args);
      },
    });
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
    lines = new SpeakerMessages({ speakers, messages, adapters: { keyOf } });
    group = fixture.chat("telegram", "-100", "group", "ops");
    fixture.speaker({ id: "s1", chat: group, accountId: BOT.id });
    sends = [];
    refuse = false;
    opened = [];
    mailSent = [];
    failOpen = false;
    failBind = false;
    failKeys = false;
    failKeysOnSend = false;
    threads = 0;
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
        keyOf: (ref) => {
          if (failKeys) throw new Error("store unavailable");
          return keyOf(ref);
        },
        accountOn: (name) =>
          name === "mail" ? { platform: "email", id: "rome@example.com" } : BOT,
      },
      channel: (name) => (name === "mail" ? mail : name === "telegram" ? TELEGRAM : null),
      open: async (input) => {
        if (failOpen) throw new Error("store unavailable");
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
    it("records a message keyed as its account hears it, as the session's prompt, once", async () => {
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

    it("keeps the parts an app hands over, host-only ones left out", async () => {
      const result = { type: "interaction_result", interactionId: "i1", value: "yes" };
      await writes.addMessage({
        sessionId: "s1",
        role: "user",
        content: JSON.stringify([{ type: "text", content: "Picked" }, result]),
        platformMessageId: "41",
      });

      const [line] = said();
      expect(line?.text).toBe("Picked");
      expect(JSON.parse(line!.parts)).toEqual([{ type: "text", content: "Picked" }, result]);
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

    it("makes a message its account already heard the session's prompt", async () => {
      const heard = messages.record({
        direction: "toRome",
        key: lines.keyIn(speakerAt(), "43"),
        place: placeIn(group),
        saidBy: { account: { platform: "telegram", id: "wei" } },
        body: { text: "already here" },
        at: new Date(0),
      });

      expect(
        await writes.addMessage({
          sessionId: "s1",
          role: "user",
          content: "[]",
          platformMessageId: "43",
        }),
      ).toEqual({ inserted: false });
      expect(linkOf("s1", heard!.id)).toMatchObject({ role: "prompt" });
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

    it("puts a send where another session in the chat catches up on it", async () => {
      // send_message without streaming: the reply goes out through the
      // host's Chats writes, never the legacy writer.
      fixture.speaker({ id: "s2", chat: group, accountId: BOT.id, agentName: "support" });

      await writes.send({
        sessionId: "s1",
        channel: "telegram",
        text: "Deploy done",
        turnId: "turn-1",
        knownToProvider: true,
      });

      expect(links.unseen("s2")).toMatchObject([{ text: "Deploy done", fromRome: true }]);
      expect(links.unseen("s1")).toEqual([]);
    });

    it("says a send as the agent the running action names for its turn, as in a worker", async () => {
      // A worker starts no turn, so only the action running in it knows that
      // the account's own agent runs this one.
      await actionExecutionContext.run(
        {
          executionId: "x1",
          rootExecutionId: "x1",
          initiator: "agent",
          turnId: "turn-9",
          agentName: "support",
        },
        () =>
          writes.send({
            sessionId: "s1",
            channel: "telegram",
            text: "On it",
            turnId: "turn-9",
            knownToProvider: true,
          }),
      );

      expect(
        testDb.db.all<{ agent: string }>(sql`SELECT sender_agent AS agent FROM chat_messages`),
      ).toEqual([{ agent: "support" }]);
    });

    it("quotes a message by the platform's id, records what the app hands over, and keeps host-only parts off record", async () => {
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

      // The channel's adapter is the one to refuse a part it does not show.
      expect(sends[0]?.out).toEqual({
        text: "Sure",
        parts: [{ type: "text", content: "Sure" }, card],
        replyTo: lines.keyIn(speakerAt(), "41"),
      });
      expect(JSON.parse(said().at(-1)!.parts)).toEqual([
        { type: "text", content: "Sure, on record" },
      ]);
    });

    it("moves the session's activity to when its message went out", async () => {
      testDb.db.run(sql`UPDATE rome_sessions SET activity_at = 0 WHERE id = 's1'`);

      await writes.send({
        sessionId: "s1",
        channel: "telegram",
        text: "x",
        knownToProvider: false,
      });

      const [session] = testDb.db.all<{ activity_at: number }>(
        sql`SELECT activity_at FROM rome_sessions WHERE id = 's1'`,
      );
      expect(session!.activity_at).toBeGreaterThan(0);
    });

    it("says a parts-only message's text parts as its text", async () => {
      await writes.send({
        sessionId: "s1",
        channel: "telegram",
        parts: [{ type: "text", content: "From parts" }],
        knownToProvider: false,
      });

      expect(sends[0]?.out.text).toBe("From parts");
    });

    it("notes an attachment-only message's attachments on record", async () => {
      await writes.send({
        sessionId: "s1",
        channel: "telegram",
        attachments: [{ type: "image", source: "https://example.com/a.png", caption: "Chart" }],
        knownToProvider: false,
      });

      expect(said().at(-1)!.text).toContain("[image: Chart]");
    });

    it("answers a message the platform took even when storage fails after", async () => {
      failKeysOnSend = true;

      const result = await writes.send({
        sessionId: "s1",
        channel: "telegram",
        text: "x",
        knownToProvider: false,
      });

      expect(result).toEqual({ messageId: "101" });
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

    it("credits a new thread's first email to the agent its turn runs, answer or not", async () => {
      await actionExecutionContext.run(
        {
          executionId: "x2",
          rootExecutionId: "x2",
          initiator: "agent",
          turnId: "turn-9",
          agentName: "support",
        },
        () =>
          writes.sendEmail({
            channel: "mail",
            text: "Plans",
            email: { to: "wei@example.com", subject: "Plans" },
            turnId: "turn-9",
            knownToProvider: false,
          }),
      );

      expect(
        testDb.db.all<{ agent: string }>(sql`SELECT sender_agent AS agent FROM chat_messages`),
      ).toEqual([{ agent: "support" }]);
    });

    it("answers an email that went out even when main cannot join its new thread", async () => {
      failOpen = true;

      const result = await writes.sendEmail({
        channel: "mail",
        text: "Plans",
        email: { to: "wei@example.com", subject: "Plans" },
        knownToProvider: false,
      });

      expect(result).toEqual({ messageId: "m1", threadId: "thread-1" });
      expect(said()).toHaveLength(1);
    });

    it("records an HTML-only email as the text its HTML reads as", async () => {
      await writes.sendEmail({
        channel: "mail",
        email: { to: "wei@example.com", subject: "Plans", html: "<p>Hello <b>Wei</b></p>" },
        knownToProvider: false,
      });
      await writes.sendEmail({
        channel: "mail",
        sessionId: "mail-1",
        email: { html: "<p>Again</p>" },
        knownToProvider: false,
      });

      expect(said().map((line) => line.text)).toEqual(["Hello **Wei**", "Again"]);
    });

    it("copies a reply on a thread Rome holds to its cc and bcc", async () => {
      await writes.sendEmail({
        channel: "mail",
        text: "Plans",
        email: { to: "wei@example.com", subject: "Plans" },
        knownToProvider: false,
      });

      await writes.sendEmail({
        channel: "mail",
        sessionId: "mail-1",
        text: "Adding Ann",
        email: { cc: ["ann@example.com"], bcc: ["boss@example.com"] },
        knownToProvider: false,
      });

      expect(mailSent[1]?.message).toMatchObject({
        text: "Adding Ann",
        cc: ["ann@example.com"],
        bcc: ["boss@example.com"],
      });
    });

    it("replies in the thread holding the email it names by id alone", async () => {
      await writes.sendEmail({
        channel: "mail",
        text: "Plans",
        email: { to: "wei@example.com", subject: "Plans" },
        knownToProvider: false,
      });

      await writes.sendEmail({
        channel: "mail",
        text: "Re",
        email: { inReplyToMessageId: "m1" },
        knownToProvider: false,
      });

      expect(opened).toEqual(["thread-1", "thread-1"]);
      expect(mailSent[1]).toMatchObject({
        to: "thread-1",
        message: { text: "Re", inReplyToMessageId: "m1" },
      });
    });

    it("answers and joins the provider's thread when storing its address fails", async () => {
      failBind = true;

      const result = await writes.sendEmail({
        channel: "mail",
        text: "Plans",
        email: { to: "wei@example.com", subject: "Plans" },
        knownToProvider: false,
      });

      expect(result).toEqual({ messageId: "m1", threadId: "thread-1" });
      expect(opened).toEqual(["thread-1"]);
    });

    it("refuses a reply whose email is in another thread than the one named", async () => {
      for (const to of ["wei@example.com", "ann@example.com"]) {
        await writes.sendEmail({
          channel: "mail",
          text: "Plans",
          email: { to, subject: "Plans" },
          knownToProvider: false,
        });
      }

      await expect(
        writes.sendEmail({
          channel: "mail",
          threadId: "thread-2",
          text: "Re",
          email: { inReplyToMessageId: "m1" },
          knownToProvider: false,
        }),
      ).rejects.toThrow("Email m1 is not in thread thread-2");
      await expect(
        writes.sendEmail({
          channel: "mail",
          sessionId: "mail-2",
          text: "Re",
          email: { inReplyToMessageId: "m1" },
          knownToProvider: false,
        }),
      ).rejects.toThrow("Email m1 is not in session mail-2's thread");
      expect(mailSent).toHaveLength(2);
    });

    it("answers an email the provider took even when storage fails after", async () => {
      failKeysOnSend = true;
      const started = await writes.sendEmail({
        channel: "mail",
        text: "Plans",
        email: { to: "wei@example.com", subject: "Plans" },
        knownToProvider: false,
      });
      failKeys = false;

      const replied = await writes.sendEmail({
        channel: "mail",
        sessionId: "mail-1",
        text: "Again",
        email: {},
        knownToProvider: false,
      });

      expect(started).toEqual({ messageId: "m1", threadId: "thread-1" });
      expect(replied).toEqual({ messageId: "m2", threadId: "thread-1" });
    });

    it("refuses a session that is not in the thread named", async () => {
      for (const to of ["wei@example.com", "ann@example.com"]) {
        await writes.sendEmail({
          channel: "mail",
          text: "Plans",
          email: { to, subject: "Plans" },
          knownToProvider: false,
        });
      }

      await expect(
        writes.sendEmail({
          channel: "mail",
          threadId: "thread-1",
          sessionId: "mail-2",
          text: "Re",
          email: {},
          knownToProvider: false,
        }),
      ).rejects.toThrow("Session mail-2 is not in thread thread-1");
      expect(mailSent).toHaveLength(2);
    });

    it("refuses a channel that sends no email before anything goes out", async () => {
      await expect(
        writes.sendEmail({
          channel: "telegram",
          sessionId: "s1",
          text: "x",
          email: {},
          knownToProvider: false,
        }),
      ).rejects.toThrow('Channel "telegram" sends no email');
      expect(sends).toEqual([]);
      expect(said()).toEqual([]);
    });

    it("refuses to reply to an email Rome holds no thread with", async () => {
      await expect(
        writes.sendEmail({
          channel: "mail",
          text: "Re",
          email: { inReplyToMessageId: "unknown" },
          knownToProvider: false,
        }),
      ).rejects.toThrow("Rome holds no email thread with message unknown");
      expect(mailSent).toEqual([]);
    });

    it("refuses a blank message to reply to, since no thread holds it, before anything goes out", async () => {
      await expect(
        writes.sendEmail({
          channel: "mail",
          threadId: "thread-1",
          text: "x",
          email: { inReplyToMessageId: " " },
          knownToProvider: false,
        }),
      ).rejects.toThrow("Rome holds no email thread with message");
      expect(mailSent).toEqual([]);
    });
  });
});
