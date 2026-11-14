import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import type { StoredWebchatMessage } from "./repository.js";
import { createTestDb, type TestDb } from "../test/helpers.js";
import { ChatsWebChatRepository } from "./chats-webchat-repository.js";

// A reaction on a message of a Concierge chat (docs/domains/chats.md#reaction):
// stored on the message, read with it, and told to whoever listens.

const text = (content: string) => JSON.stringify([{ type: "text", content }]);

describe("message reactions", () => {
  let testDb: TestDb;
  let repo: ChatsWebChatRepository;

  beforeEach(async () => {
    testDb = createTestDb();
    repo = new ChatsWebChatRepository(testDb.db);
    await repo.createSession("concierge", "Concierge");
    await repo.createSession("other", "Other");
    await repo.recordUserInput("m1", "concierge", text("one"));
    await repo.recordUserInput("m2", "concierge", text("two"));
    await repo.recordUserInput("o1", "other", text("elsewhere"));
  });
  afterEach(() => testDb.close());

  const reactionsOf = async (chatId: string) =>
    new Map((await repo.getMessages(chatId)).map((m) => [m.id, m.reaction ?? null]));

  it("reads a message with no reaction without the field", async () => {
    const messages = await repo.getMessages("concierge");
    expect(messages).toHaveLength(2);
    for (const message of messages) expect(message).not.toHaveProperty("reaction");
  });

  it("stores a reaction on its message, reads it back with the message, and keeps the others bare", async () => {
    expect(await repo.setMessageReaction("concierge", "m1", "👀")).toBe(true);
    expect(await reactionsOf("concierge")).toEqual(
      new Map([
        ["m1", "👀"],
        ["m2", null],
      ]),
    );
    expect(await reactionsOf("other")).toEqual(new Map([["o1", null]]));
    // The message a turn reads carries it too.
    expect((await repo.getReplyTarget("concierge", "m1"))?.reaction).toBe("👀");
  });

  it("replaces a reaction with the new one, and clears it with null", async () => {
    await repo.setMessageReaction("concierge", "m1", "👀");
    await repo.setMessageReaction("concierge", "m1", "✅");
    expect((await reactionsOf("concierge")).get("m1")).toBe("✅");
    expect(await repo.setMessageReaction("concierge", "m1", null)).toBe(true);
    expect((await reactionsOf("concierge")).get("m1")).toBeNull();
    expect((await repo.getMessages("concierge"))[0]).not.toHaveProperty("reaction");
  });

  it("keeps any string it is given, as clients draw it", async () => {
    await repo.setMessageReaction("concierge", "m2", "🦄");
    expect((await reactionsOf("concierge")).get("m2")).toBe("🦄");
  });

  it("answers false for a message the chat does not hold, and one of another chat", async () => {
    expect(await repo.setMessageReaction("concierge", "nope", "👍")).toBe(false);
    expect(await repo.setMessageReaction("concierge", "o1", "👍")).toBe(false);
    expect(await repo.setMessageReaction("missing-chat", "m1", "👍")).toBe(false);
    expect(await reactionsOf("other")).toEqual(new Map([["o1", null]]));
  });

  it("tells the listeners each change, and not one that set nothing", async () => {
    const told: unknown[] = [];
    const off = repo.onMessageReaction((event) => told.push(event));
    await repo.setMessageReaction("concierge", "m1", "👍");
    await repo.setMessageReaction("concierge", "m1", null);
    await repo.setMessageReaction("concierge", "nope", "👍");
    off();
    await repo.setMessageReaction("concierge", "m1", "❤️");
    expect(told).toEqual([
      { sessionId: "concierge", messageId: "m1", reaction: "👍" },
      { sessionId: "concierge", messageId: "m1", reaction: null },
    ]);
  });

  it("is no new message: a reaction inserts nothing", async () => {
    const inserted: StoredWebchatMessage[] = [];
    repo.onMessageInserted((message) => inserted.push(message));
    await repo.setMessageReaction("concierge", "m1", "👀");
    expect(inserted).toEqual([]);
    expect(await repo.getMessages("concierge")).toHaveLength(2);
  });
});
