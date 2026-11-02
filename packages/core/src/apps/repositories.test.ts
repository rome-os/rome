import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import type { ChatId, MessageReceipt, OutgoingMessage } from "@rome-os/app-runtime";
import { sql } from "drizzle-orm";
import { SettingsRepository } from "../db/repositories/settings.js";
import { WebChatRepository } from "../db/repositories/webchat.js";
import { createTestDb, testChatWiring, type TestDb } from "../test/helpers.js";
import { createAppRuntimeRepositories } from "./repositories.js";

// An app's chats. What these pin: a message an app's seat sends goes out on
// the channel and is on record once in the chat the seat stands in, as Rome's.

describe("app chat repository", () => {
  let testDb: TestDb;
  let sent: Array<{ channel: string; address: ChatId; message: OutgoingMessage }>;

  beforeEach(() => {
    testDb = createTestDb();
    sent = [];
  });
  afterEach(() => testDb.close());

  const chats = () => {
    const webchatRepo = new WebChatRepository(testDb.db);
    const wiring = testChatWiring(testDb.db, webchatRepo);
    return createAppRuntimeRepositories({
      settingsRepo: new SettingsRepository(testDb.db),
      webchatRepo,
      chatRepo: wiring.chats,
      chatMessages: wiring.messages,
      adapters: wiring.adapters,
      sendOn: async (channel, address, message): Promise<MessageReceipt> => {
        sent.push({ channel, address, message });
        return { messageId: "m-9", chatId: address };
      },
      links: wiring.links,
      replies: wiring.replies,
      reads: wiring.reads,
      seatLines: wiring.seatLines,
    }).chats!;
  };

  it("sends a seat's message on its channel and records it once in the seat's chat", async () => {
    const repository = chats();
    const seat = await repository.ensureChannelChat({
      channel: "telegram",
      threadId: "topic-7",
      parentThreadId: "group-1",
      threadType: "group",
      agentName: "main",
    });

    await repository.send({
      sessionId: seat.id,
      channel: "telegram",
      text: "on it",
      knownToProvider: false,
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ channel: "telegram", message: { text: "on it" } });
    const lines = testDb.db.all<{
      thread_id: string | null;
      sender_agent: string | null;
      text: string;
    }>(sql`SELECT thread_id, sender_agent, text FROM chat_messages`);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ thread_id: "topic-7", text: "on it" });
    expect(lines[0]!.sender_agent).not.toBeNull();
  });

  it("refuses a seat that stands in no chat, and sends nothing", async () => {
    await expect(
      chats().send({
        sessionId: "no-such-row",
        channel: "telegram",
        text: "on it",
        knownToProvider: false,
      }),
    ).rejects.toThrow();
    expect(sent).toHaveLength(0);
  });
});
