import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import type { ChatId } from "@rome-os/app-runtime";
import { sql } from "drizzle-orm";
import { ChatRepository } from "../chats/storage/chat-repository.js";
import { MessageRepository } from "../chats/storage/message-repository.js";
import type { InboundMessage } from "../chats/storage/message.js";
import { type ChatRef, placeIn } from "../chats/storage/place.js";
import { createTestDb, type TestDb } from "../test/helpers.js";
import { TurnLinks } from "./turn-links.js";

const ALICE = { platform: "telegram", id: "alice" };
const ROME = { platform: "telegram", id: "rome_bot" };
const SEAT_STARTED = new Date("2026-10-29T01:00:00Z");

describe("TurnLinks", () => {
  let testDb: TestDb;
  let messages: MessageRepository;
  let links: TurnLinks;
  let chat: ChatRef;

  function heard(key: string, secondsAfterSeat: number, extra: Partial<InboundMessage> = {}) {
    const recorded = messages.record({
      direction: "toRome",
      key,
      place: placeIn(chat),
      saidBy: { account: ALICE, name: "Alice" },
      body: { text: key },
      at: new Date(SEAT_STARTED.getTime() + secondsAfterSeat * 1000),
      ...extra,
    });
    if (!recorded) throw new Error(`${key} was not recorded`);
    return recorded.id;
  }

  function seat(id: string, threadId: string | null = null) {
    testDb.db.run(sql`
      INSERT INTO rome_sessions (id, name, type, chat_id, chat_platform, thread_id, account_id, created_at, activity_at)
      VALUES (${id}, 'Seat', 'channel', ${chat.id}, 'telegram', ${threadId}, 'rome_bot',
        ${SEAT_STARTED.getTime() / 1000}, ${SEAT_STARTED.getTime() / 1000})
    `);
  }

  beforeEach(() => {
    testDb = createTestDb();
    chat = new ChatRepository(testDb.db).start(
      { platform: "telegram", externalId: "-100" as ChatId },
      "group",
      null,
    ).ref;
    messages = new MessageRepository(testDb.db);
    links = new TurnLinks(testDb.db, messages);
    seat("seat-1");
  });
  afterEach(() => testDb.close());

  it("link a prompt queued, then to the turn that runs it, keeping its input state", () => {
    const ask = heard("m1", 5);

    links.prompt(ask, "seat-1", null, "queued");
    expect(links.linkOf("seat-1", ask)).toMatchObject({
      role: "prompt",
      turnId: null,
      inputState: "queued",
    });

    links.promptRuns("seat-1", ask, "turn-1", "submitted");
    expect(links.linkOf("seat-1", ask)).toMatchObject({
      turnId: "turn-1",
      inputState: "submitted",
    });

    links.forgetInputsInFlight();
    expect(links.linkOf("seat-1", ask)?.inputState).toBe("unknown");
  });

  it("make a line caught up on the session's prompt when it later wakes a turn", () => {
    const line = heard("m1", 5);
    links.seen([line], "seat-1", "turn-1");
    links.prompt(line, "seat-1", "turn-2");

    expect(links.linkOf("seat-1", line)).toMatchObject({ role: "prompt", turnId: "turn-2" });
  });

  it("queue a line caught up on as a prompt without the turn that caught up on it", () => {
    const line = heard("m1", 5);
    links.seen([line], "seat-1", "turn-1");
    links.prompt(line, "seat-1", null, "queued");

    expect(links.linkOf("seat-1", line)).toMatchObject({
      role: "prompt",
      turnId: null,
      inputState: "queued",
    });
  });

  it("read two alike lines with their own keys as two lines", () => {
    const first = heard("m1", 5, { body: { text: "ok" } });
    const second = heard("m2", 5, { body: { text: "ok" } });

    expect(links.unseen("seat-1").map((line) => line.id)).toEqual([first, second]);
    links.seen([first], "seat-1", "turn-1");
    expect(links.unseen("seat-1").map((line) => line.id)).toEqual([second]);
  });

  it("read one copy of a line two of Rome's accounts each hold, and none once one is seen", () => {
    const mine = heard("rome_bot:5", 5, { body: { text: "ok" } });
    const theirs = heard("other_bot:9", 5, { body: { text: "ok" } });

    expect(links.unseen("seat-1").map((line) => line.id)).toEqual([mine]);
    links.seen([theirs], "seat-1", "turn-1");
    expect(links.unseen("seat-1")).toEqual([]);
    // The copy is linked as seen, so later catch-ups do not read it again.
    expect(links.linkOf("seat-1", mine)).toMatchObject({ role: "seen", turnId: null });
  });

  it("read a second alike line as its own, once a copy of the first is seen", () => {
    const mine = heard("rome_bot:5", 5, { body: { text: "ok" } });
    const theirs = heard("other_bot:9", 5, { body: { text: "ok" } });
    const again = heard("rome_bot:6", 5, { body: { text: "ok" } });
    links.seen([theirs], "seat-1", "turn-1");
    links.prompt(mine, "seat-1", "turn-1");

    expect(links.unseen("seat-1").map((line) => line.id)).toEqual([again]);
  });

  it("hold every copy of an undecided line out of catch-up, and read one once it is decided", () => {
    const mine = heard("rome_bot:5", 5, { body: { text: "ok" } });
    heard("other_bot:9", 5, { body: { text: "ok" } });
    links.wakeUndecided(mine);

    expect(links.unseen("seat-1")).toEqual([]);
    links.wakeDecided(mine);
    expect(links.unseen("seat-1").map((line) => line.id)).toEqual([mine]);
  });

  it("read one copy of a photo two accounts saved under their own names and places", () => {
    const photo = (key: string, fileName: string, path: string) =>
      heard(key, 5, {
        body: {
          text: "look",
          attachments: [{ type: "image", fileName, localPath: path, caption: "sunset" }],
        },
      });
    const mine = photo("rome_bot:5", "photo_5.jpg", "/media/rome_bot/5/photo_5.jpg");
    photo("other_bot:9", "photo_9.jpg", "/media/other_bot/9/photo_9.jpg");

    expect(links.unseen("seat-1").map((line) => line.id)).toEqual([mine]);
    links.seen([mine], "seat-1", "turn-1");
    expect(links.unseen("seat-1")).toEqual([]);
  });

  it("read alike lines whose keys only look per-account as their own outside a basic group", () => {
    chat = new ChatRepository(testDb.db).start(
      { platform: "telegram", externalId: "-1001234567890123" as ChatId },
      "group",
      null,
    ).ref;
    testDb.db.run(sql`
      INSERT INTO rome_sessions (id, name, type, chat_id, chat_platform, account_id, created_at, activity_at)
      VALUES ('seat-2', 'Seat', 'channel', ${chat.id}, 'telegram', 'rome_bot',
        ${SEAT_STARTED.getTime() / 1000}, ${SEAT_STARTED.getTime() / 1000})
    `);
    const first = heard("rome:a", 5, { body: { text: "ok" } });
    const second = heard("other:b", 5, { body: { text: "ok" } });
    links.seen([first], "seat-2", "turn-1");

    expect(links.unseen("seat-2").map((line) => line.id)).toEqual([second]);
  });

  it("answer each message's prompt or answer turn, leaving out lines only caught up on", () => {
    const ask = heard("m1", 5);
    const reply = heard("m2", 6, { saidBy: { account: ROME, agent: "main" } });
    const aside = heard("m3", 7);
    links.prompt(ask, "seat-1", "turn-1");
    links.answer(reply, "seat-1", "turn-1");
    links.seen([aside], "seat-1", "turn-1");

    const turns = links.turnsOf([ask, reply, aside]);
    expect([...turns.keys()].sort()).toEqual([ask, reply].sort());
    expect(turns.get(reply)).toMatchObject({ role: "answer", turnId: "turn-1" });
  });

  it("catch a seat up on what it has not seen since it started, oldest first", () => {
    heard("before", -60);
    heard("same-second", 0);
    const ask = heard("m1", 5);
    const aside = heard("m2", 6);
    const later = heard("m3", 7, { replyTo: "m2" });
    links.prompt(ask, "seat-1", "turn-1");

    const unseen = links.unseen("seat-1");
    expect(unseen.map((line) => line.id)).toEqual([aside, later]);
    expect(unseen[1]?.quoted).toMatchObject({ id: aside, text: "m2" });

    links.seen([aside, later], "seat-1", "turn-2");
    expect(links.unseen("seat-1")).toEqual([]);
  });

  it("read a line of Rome's that kept no name as Rome's", () => {
    heard("m1", 5, { saidBy: { account: ROME, agent: "main" } });

    expect(links.unseen("seat-1")[0]).toMatchObject({ senderName: "Rome", fromRome: true });
  });

  it("hold a line out of catch-up while its wake is undecided", () => {
    const line = heard("m1", 5);
    links.wakeUndecided(line);
    expect(links.unseen("seat-1")).toEqual([]);

    links.wakeDecided(line);
    expect(links.unseen("seat-1").map((unseen) => unseen.id)).toEqual([line]);
  });

  it("catch up nothing for a session in no chat, and link no message Chats does not hold", () => {
    testDb.db.run(sql`
      INSERT INTO rome_sessions (id, name, type, created_at, activity_at)
      VALUES ('run-1', 'Run', 'subagent', 0, 0)
    `);
    expect(links.unseen("run-1")).toEqual([]);

    links.seen([9999], "seat-1", "turn-1");
    expect(links.linkOf("seat-1", 9999)).toBeNull();
  });
});
