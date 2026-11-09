import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import type { Channel, ChatId } from "@rome-os/app-runtime";
import { sql } from "drizzle-orm";
import { ChatRepository } from "../chats/storage/chat-repository.js";
import { MessageRepository } from "../chats/storage/message-repository.js";
import { placeIn, type ChatRef } from "../chats/storage/place.js";
import type { ChannelChatAdapter, Outbound } from "../connections/chat-adapter.js";
import { createTestDb, type TestDb } from "../test/db.js";
import { SpeakerReplies } from "./speaker-replies.js";
import { Speakers } from "./speakers.js";
import { TurnLinks } from "./turn-links.js";

const CHANNEL = { name: "telegram" } as Channel;

describe("SpeakerReplies", () => {
  let testDb: TestDb;
  let chat: ChatRef;
  let messages: MessageRepository;
  let links: TurnLinks;
  let speakers: Speakers;
  let sends: Array<{ chat: string; threadId: ChatId | null; out: Outbound }>;
  let landsIn: ChatId | null;
  let refuse: boolean;

  const adapter = {
    account: { platform: "telegram", id: "rome_bot" },
    async send(chatKey: string, threadId: ChatId | null, out: Outbound) {
      if (refuse) throw new Error("refused");
      sends.push({ chat: chatKey, threadId, out });
      return { key: `k${sends.length}`, threadId: landsIn ?? threadId };
    },
  } as unknown as ChannelChatAdapter;

  const replies = () =>
    new SpeakerReplies({
      speakers,
      adapters: { of: () => adapter },
      messages,
      links,
    });

  function speaker(id: string, threadId: string | null, agent: string | null = "sales") {
    testDb.db.run(sql`
      INSERT INTO rome_sessions (id, name, type, chat_id, chat_platform, thread_id, account_id, agent_name, created_at, activity_at)
      VALUES (${id}, 'Speaker', 'channel', ${chat.id}, 'telegram', ${threadId}, 'rome_bot', ${agent}, 0, 0)
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
    speakers = new Speakers(testDb.db);
    sends = [];
    landsIn = null;
    refuse = false;
    speaker("speaker-1", null);
  });
  afterEach(() => testDb.close());

  it("send through the speaker's adapter, on record as the speaker's and as the turn's answer", async () => {
    const sent = await replies().send("speaker-1", CHANNEL, { text: "hi" }, { turnId: "turn-1" });

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
    expect(links.linkOf("speaker-1", sent!.id!)).toMatchObject({
      role: "answer",
      turnId: "turn-1",
    });
  });

  it("record a send in the thread the platform placed it in", async () => {
    landsIn = "topic-7" as ChatId;

    const sent = await replies().send("speaker-1", CHANNEL, { text: "hi" });

    expect(sent?.landedIn).toBe("topic-7");
    expect(messages.byIds([sent!.id!])[0]?.place.threadId).toBe("topic-7");
    expect(messages.read(placeIn(chat)).messages).toEqual([]);
  });

  it("record nothing when the platform refuses a send", async () => {
    refuse = true;

    await expect(replies().send("speaker-1", CHANNEL, { text: "hi" })).rejects.toThrow("refused");
    expect(messages.read(placeIn(chat)).messages).toEqual([]);
  });

  it("send nothing through a channel of another of Rome's accounts", async () => {
    const other = { ...adapter, account: { platform: "telegram", id: "other_bot" } };
    const wrong = new SpeakerReplies({
      speakers,
      adapters: { of: () => other as ChannelChatAdapter },
      messages,
      links,
    });

    await expect(wrong.send("speaker-1", CHANNEL, { text: "hi" })).rejects.toThrow("other_bot");
    expect(sends).toEqual([]);
    expect(messages.read(placeIn(chat)).messages).toEqual([]);
  });

  it("say what a caller delivers, as the speaker's", async () => {
    const said = await replies().say(
      "speaker-1",
      [{ type: "text", content: "hello" }],
      async (to, key) => `${to.agent}:${key}`,
      { turnId: "turn-2" },
    );

    expect(messages.byIds([said!.id!])[0]).toMatchObject({
      key: "sales:-1001234567890123",
      body: { text: "hello" },
    });
    expect(links.linkOf("speaker-1", said!.id!)).toMatchObject({
      role: "answer",
      turnId: "turn-2",
    });
  });

  it("move the session's activity up to a message it sends", async () => {
    const moved: Array<[string, number]> = [];
    await new SpeakerReplies({
      speakers,
      adapters: { of: () => adapter },
      messages,
      links,
      // Chats keeps a message's time to the second.
      activity: (sessionId, at) => moved.push([sessionId, Math.floor(at.getTime() / 1000)]),
    }).send("speaker-1", CHANNEL, { text: "hi" }, { turnId: "turn-5" });

    const [line] = messages.read(placeIn(chat)).messages;
    expect(moved).toEqual([["speaker-1", Math.floor(line!.at.getTime() / 1000)]]);
  });

  it("send as the agent whose turn sends, when the send names none", async () => {
    // The session still names the agent it opened with, and the account's own
    // agent ran the turn.
    const speaking = replies();
    speaking.runs("turn-5", "support");

    const sent = await speaking.send("speaker-1", CHANNEL, { text: "hi" }, { turnId: "turn-5" });
    const unnoted = await speaking.send("speaker-1", CHANNEL, { text: "yo" }, { turnId: "turn-6" });

    expect(messages.byIds([sent!.id!])[0]?.saidBy).toMatchObject({ agent: "support" });
    expect(messages.byIds([unnoted!.id!])[0]?.saidBy).toMatchObject({ agent: "sales" });
  });

  it("answer a delivered reply even when its turn link fails", async () => {
    const broken = new SpeakerReplies({
      speakers,
      adapters: { of: () => adapter },
      messages,
      links: {
        answer: () => {
          throw new Error("disk full");
        },
      },
    });

    const sent = await broken.send("speaker-1", CHANNEL, { text: "hi" }, { turnId: "turn-1" });
    const said = await broken.say(
      "speaker-1",
      [{ type: "text", content: "yo" }],
      async () => "k9",
      {
        turnId: "turn-1",
      },
    );

    expect(sent).toMatchObject({ id: expect.any(Number), sent: "k1" });
    expect(said).toMatchObject({ id: expect.any(Number) });
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

describe("Speakers", () => {
  it("read a speaker's place, account and agent, the main agent's when it kept none", () => {
    const testDb = createTestDb();
    const chat = new ChatRepository(testDb.db).start(
      { platform: "telegram", externalId: "-42" as ChatId },
      "group",
      null,
    ).ref;
    testDb.db.run(sql`
      INSERT INTO rome_sessions (id, name, type, chat_id, chat_platform, thread_id, created_at, activity_at)
      VALUES ('speaker-1', 'Speaker', 'channel', ${chat.id}, 'telegram', 'topic-1', 0, 0)
    `);

    expect(new Speakers(testDb.db).speakerOf("speaker-1")).toEqual({
      sessionId: "speaker-1",
      place: placeIn(chat, "topic-1" as ChatId),
      accountId: "telegram",
      agent: "main",
    });
    expect(new Speakers(testDb.db).speakerOf("nobody")).toBeNull();
    testDb.close();
  });
});
