import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import type { ChatId } from "@rome-os/app-runtime";
import { ChatRepository } from "../chats/storage/chat-repository.js";
import { MessageRepository } from "../chats/storage/message-repository.js";
import { chatKey, placeIn } from "../chats/storage/place.js";
import { romeSessions } from "../db/schema/system.js";
import { createTestDb, testChatRepository, type TestDb } from "../test/helpers.js";
import { ChatSettingsRepository } from "./repository.js";

describe("ChatSettingsRepository.hasMessageHistory", () => {
  let testDb: TestDb;
  beforeEach(() => {
    testDb = createTestDb();
  });
  afterEach(() => testDb.close());

  const session = (id: string, chatId: number | null) =>
    testDb.db
      .insert(romeSessions)
      .values({
        id,
        name: id,
        type: "channel",
        sourceChannel: "telegram",
        sourceThreadId: id,
        sourceThreadType: "private",
        chatId,
        createdAt: new Date(),
      })
      .run();

  it("counts a line said in the chat a session stands in", () => {
    const chats = new ChatRepository(testDb.db);
    const said = chats.start(chatKey("telegram", "7" as ChatId), "dm", "Ana");
    const quiet = chats.start(chatKey("telegram", "8" as ChatId), "dm", "Ben");
    new MessageRepository(testDb.db).record({
      direction: "toRome",
      key: "m1",
      place: placeIn(said.ref),
      saidBy: { account: { platform: "telegram", id: "7" } },
      body: { text: "hi" },
      at: new Date(),
    });
    session("channel:telegram:7", said.ref.id);
    session("channel:telegram:8", quiet.ref.id);
    const repository = new ChatSettingsRepository(testDb.db, testChatRepository(testDb.db));

    expect(repository.hasMessageHistory("channel:telegram:7")).toBe(true);
    expect(repository.hasMessageHistory("channel:telegram:8")).toBe(false);
  });
});
