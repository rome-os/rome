import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import type { ChatId } from "@rome-os/app-runtime";
import { sql } from "drizzle-orm";
import { ChatRepository } from "../chats/storage/chat-repository.js";
import { MessageRepository } from "../chats/storage/message-repository.js";
import { placeIn, type ChatRef } from "../chats/storage/place.js";
import { Speakers } from "../sessions/speakers.js";
import { createTestDb, type TestDb } from "../test/helpers.js";
import { chatKey } from "./chat-ids.js";
import { runLines, SpeakerLines } from "./speaker-lines.js";

describe("SpeakerLines", () => {
  let testDb: TestDb;
  let chat: ChatRef;
  let messages: MessageRepository;
  let lines: SpeakerLines;

  function heard(key: string, text: string) {
    return messages.record({
      direction: "toRome",
      key,
      place: placeIn(chat),
      saidBy: { account: { platform: "telegram", id: "wei" }, name: "Wei" },
      body: { text },
      at: new Date("2026-10-29T01:00:00Z"),
    })!.id;
  }

  beforeEach(() => {
    testDb = createTestDb();
    // A basic group, where each of Rome's accounts numbers its own lines.
    chat = new ChatRepository(testDb.db).start(
      { platform: "telegram", externalId: "-42" as ChatId },
      "group",
      null,
    ).ref;
    testDb.db.run(sql`
      INSERT INTO rome_sessions (id, name, type, chat_id, chat_platform, account_id, created_at, activity_at)
      VALUES ('speaker-1', 'Speaker', 'channel', ${chat.id}, 'telegram', 'rome_bot', 0, 0)
    `);
    messages = new MessageRepository(testDb.db);
    lines = new SpeakerLines({
      speakers: new Speakers(testDb.db),
      messages,
      adapters: { keyOf: () => chatKey("telegram", "-42" as ChatId) },
    });
  });
  afterEach(() => testDb.close());

  it("turn a platform id into the line the speaker's account holds, and back", () => {
    const speaker = { place: placeIn(chat), accountId: "rome_bot" };
    const id = heard("rome_bot:7", "hi");
    heard("other_bot:7", "else");

    expect(lines.keyIn(speaker, "7")).toBe("rome_bot:7");
    expect(lines.idIn(speaker, "7")).toBe(id);
    expect(lines.idIn(speaker, "8")).toBeNull();
    expect(lines.platformIdIn(speaker, "rome_bot:7")).toBe("7");
    expect(lines.platformIdIn(speaker, "other_bot:7")).toBeNull();
    expect(lines.platformIdIn(speaker, "rome:0190")).toBeNull();
  });

  it("find the lines a run names by platform id where its session stands", async () => {
    const asked = heard("rome_bot:7", "what now?");
    heard("rome_bot:6", "earlier");

    expect(await lines.recorded("speaker-1", "7")).toMatchObject({ id: asked });
    expect(await lines.recorded("nobody", "7")).toBeNull();
    expect(
      await runLines(lines, "speaker-1", { platformMessageId: "7", replyTo: { messageId: "6" } }),
    ).toMatchObject({ prompt: asked, quoted: { text: "earlier", senderName: "Wei" } });
    expect(await runLines(undefined, "speaker-1", { platformMessageId: "7" })).toEqual({
      prompt: null,
      quoted: null,
    });
  });
});
