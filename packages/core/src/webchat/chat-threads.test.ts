import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { sql } from "drizzle-orm";
import type {
  ChatThreadPlaced,
  ChatThreadPlacement,
  StoredWebchatMessage,
} from "../db/repositories/webchat.js";
import { createTestDb, type TestDb } from "../test/helpers.js";
import { ChatsWebChatRepository } from "./chats-webchat-repository.js";

// Chat threads in a Concierge chat (docs/domains/chats.md#chat-thread): where
// the guardian's and the Concierge's messages go, how one thread reads, and
// what the chat's events say about it.

const text = (content: string) => JSON.stringify([{ type: "text", content }]);
const CHAT = "concierge";

describe("chat threads", () => {
  let testDb: TestDb;
  let repo: ChatsWebChatRepository;
  let placed: ChatThreadPlaced[];
  let inserted: StoredWebchatMessage[];

  beforeEach(async () => {
    testDb = createTestDb();
    repo = new ChatsWebChatRepository(testDb.db);
    await repo.createSession(CHAT, "Concierge");
    placed = [];
    inserted = [];
    repo.onChatThreadPlaced((event) => placed.push(event));
    repo.onMessageInserted((message) => inserted.push(message));
  });
  afterEach(() => testDb.close());

  const guardian = (id: string, chatThread?: ChatThreadPlacement) =>
    repo.recordUserInput(id, CHAT, text(id), undefined, undefined, chatThread);
  const concierge = async (turnId: string, words: string, chatThread: ChatThreadPlacement) =>
    (await repo.addBackendMessage(CHAT, turnId, [{ type: "text", content: words }], { chatThread }))
      .id;
  const threadOf = (id: string) => repo.chatThreadOf(CHAT, id);

  it("starts the first unmarked message's own thread, and later ones join the latest", async () => {
    await guardian("m1", { latest: true });
    const reply = await concierge("t1", "On it", { in: "m1" });
    await guardian("m2", { latest: true });

    expect(await threadOf("m1")).toBe("m1");
    expect(await threadOf(reply)).toBe("m1");
    expect(await threadOf("m2")).toBe("m1");
  });

  it("moves an unmarked message when the Concierge starts a new thread for it", async () => {
    await guardian("m1", { latest: true });
    await guardian("m2", { latest: true });

    expect(await repo.placeInChatThread(CHAT, "m2", { starts: true })).toBe("m2");
    expect(await threadOf("m2")).toBe("m2");
    expect(placed.at(-1)).toEqual({ sessionId: CHAT, messageId: "m2", chatThreadId: "m2" });
  });

  it("never moves a message the guardian placed in a thread or sent as a reply", async () => {
    await guardian("m1", { latest: true });
    await guardian("m2", { starts: true });
    await guardian("m3", { in: "m1", chosen: true });

    await repo.placeInChatThread(CHAT, "m3", { in: "m2" });
    await repo.placeInChatThread(CHAT, "m3", { starts: true });

    expect(await threadOf("m3")).toBe("m1");
  });

  it("reads one thread's messages in the order they were said, through its index", async () => {
    await guardian("m1", { latest: true });
    const first = await concierge("t1", "Meeting at 3?", { in: "m1" });
    await guardian("m2", { starts: true });
    await concierge("t2", "Flights to Haikou", { in: "m2" });
    await guardian("m3", { in: first, chosen: true });

    const thread = await repo.getChatThreadMessages(CHAT, first);

    expect(thread.map((message) => message.id)).toEqual(["m1", first, "m3"]);
    expect(thread.every((message) => message.chatThreadId === "m1")).toBe(true);
    const plan = testDb.db.all<{ detail: string }>(sql`
      EXPLAIN QUERY PLAN SELECT id FROM chat_messages
      WHERE chat_id = 1 AND (chat_thread_id = 'm1' OR key = 'm1')
    `);
    expect(plan.map((row) => row.detail).join("\n")).toContain("idx_chat_messages_chat_thread");
  });

  it("shows a message from before chat threads alone in its thread", async () => {
    await guardian("old");

    expect(await threadOf("old")).toBe("old");
    expect((await repo.getChatThreadMessages(CHAT, "old")).map((message) => message.id)).toEqual([
      "old",
    ]);
  });

  it("carries the thread on message events", async () => {
    await guardian("m1", { latest: true });
    await concierge("t1", "On it", { in: "m1" });

    expect(placed[0]).toEqual({ sessionId: CHAT, messageId: "m1", chatThreadId: "m1" });
    expect(inserted.at(-1)?.chatThreadId).toBe("m1");
    expect((await repo.getMessages(CHAT)).map((message) => message.chatThreadId)).toEqual([
      "m1",
      "m1",
    ]);
  });
});
