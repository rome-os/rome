import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import type { ChatId } from "@rome-os/app-runtime";
import { ChatEvents } from "../chats/events.js";
import { StoredMessages } from "../chats/message-repository.js";
import { chatKey, placeIn } from "../chats/place.js";
import { SettingsRepository } from "../db/repositories/settings.js";
import { WebChatRepository } from "../db/repositories/webchat.js";
import { createTestDb, testChatRepository, type TestDb } from "../test/helpers.js";
import { createAppRuntimeRepositories } from "./repositories.js";

// An app's chats. What these pin: a message an app sent into the conversation
// it opened is on record in that conversation's place, as Rome's.

describe("app chat repository", () => {
  let testDb: TestDb;
  let messages: StoredMessages;

  beforeEach(() => {
    testDb = createTestDb();
    messages = new StoredMessages(new WebChatRepository(testDb.db), new ChatEvents(), {
      channelsOn: (platform) => (platform === "telegram" ? ["telegram"] : []),
    });
  });
  afterEach(() => testDb.close());

  const chats = () =>
    createAppRuntimeRepositories({
      settingsRepo: new SettingsRepository(testDb.db),
      webchatRepo: new WebChatRepository(testDb.db),
      chatRepo: testChatRepository(testDb.db),
      chatMessages: messages,
    }).chats!;

  it("records a sent message in the place of the conversation it names", async () => {
    const repository = chats();
    const thread = await repository.ensureChannelChat({
      channel: "telegram",
      threadId: "topic-7",
      parentThreadId: "group-1",
      threadType: "group",
      agentName: "main",
    });

    await repository.recordOutboundMessage({
      sessionId: thread.id,
      content: JSON.stringify([{ type: "text", content: "on it" }]),
      platformMessageId: "m-9",
      senderId: "rome",
      senderName: "Rome",
      turnId: "turn-1",
      knownToProvider: true,
    });

    const place = placeIn(chatKey("telegram", "group-1" as ChatId), "topic-7" as ChatId);
    expect((await messages.recent(place, 10)).messages).toMatchObject([
      {
        direction: "fromRome",
        body: { text: "on it" },
        platformMessageId: "m-9",
        turnId: "turn-1",
      },
    ]);
  });

  it("refuses a conversation that is no chat on a messaging channel", async () => {
    await expect(
      chats().recordOutboundMessage({
        sessionId: "no-such-row",
        content: JSON.stringify([{ type: "text", content: "on it" }]),
        knownToProvider: false,
      }),
    ).rejects.toThrow("No place for conversation no-such-row");
  });
});
