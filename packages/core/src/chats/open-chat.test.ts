import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import type { ChatId } from "@rome-os/app-runtime";
import { WebChatRepository } from "../db/repositories/webchat.js";
import { channelChatId } from "../db/session-kind.js";
import { createTestDb, testChatRepository, type TestDb } from "../test/helpers.js";
import type { ChatRepository } from "./chat-repository.js";
import { openChannelChat } from "./open-chat.js";
import { chatKey } from "./place.js";

describe("openChannelChat", () => {
  let testDb: TestDb;
  let deps: { chats: ChatRepository; webchatRepo: WebChatRepository };

  beforeEach(() => {
    testDb = createTestDb();
    deps = { chats: testChatRepository(testDb.db), webchatRepo: new WebChatRepository(testDb.db) };
  });
  afterEach(() => testDb.close());

  it("starts the chat a first message reaches Rome in, and answers its row", async () => {
    const record = await openChannelChat(deps, {
      channel: "telegram",
      threadId: "42",
      threadType: "private",
      threadName: "Alice",
      agentName: "sales",
    });

    expect(record).toEqual({ id: channelChatId("telegram", "42"), agentName: "sales" });
    expect(deps.chats.byKey(chatKey("telegram", "42" as ChatId))?.state()).toMatchObject({
      kind: "dm",
      name: "Alice",
      participants: [{ account: { platform: "telegram", id: "telegram" }, romes: true }],
    });
  });

  it("binds no agent to a chat main answers", async () => {
    const record = await openChannelChat(deps, {
      channel: "telegram",
      threadId: "42",
      agentName: "main",
    });

    expect(record.agentName).toBeNull();
  });

  it("starts a thread's chat, and the thread's own row under it", async () => {
    const record = await openChannelChat(deps, {
      channel: "telegram",
      threadId: "-100:7",
      parentThreadId: "-100",
      agentName: "main",
    });

    expect(record.id).toBe(channelChatId("telegram", "-100:7"));
    expect(deps.chats.byKey(chatKey("telegram", "-100" as ChatId))?.kind).toBe("group");
    expect(deps.chats.byKey(chatKey("telegram", "-100:7" as ChatId))).toBeNull();
  });

  it("starts no chat at a dashboard address", async () => {
    await expect(
      openChannelChat(deps, { channel: "webchat", threadId: "chat-9", agentName: "main" }),
    ).rejects.toThrow("No chat at webchat address chat-9");
  });
});
