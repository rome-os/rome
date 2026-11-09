import { describe, expect, it } from "@rstest/core";
import { sessions } from "../db/schema.js";
import { createTestDb } from "../test/db.js";
import { ChatsWebChatRepository } from "./chats-webchat-repository.js";
import { webchatSessionKey } from "../core/agent-session-key.js";
import { MODEL_SELECTIONS } from "../agent/index.js";
import { storeSubagentParent } from "../agent/index.js";
import { ChatSessionSettings } from "./chat-session-settings.js";

describe("ChatSessionSettings", () => {
  async function setup() {
    const testDb = createTestDb();
    const webchatRepo = new ChatsWebChatRepository(testDb.db);
    await webchatRepo.createSession("chat-1", "Chat", undefined, undefined, "claude-opus");
    const store = (id: string, channelThreadKey: string) =>
      testDb.db
        .insert(sessions)
        .values({
          id,
          agentName: "main",
          channelThreadKey,
          createdAt: new Date(),
          lastActiveAt: new Date(),
          status: "active",
        })
        .run();
    return { settings: new ChatSessionSettings({ webchatRepo }), store };
  }

  it("answers the model saved by the web chat whose own session it is", async () => {
    const { settings, store } = await setup();
    store("own", webchatSessionKey("chat-1"));
    expect(await settings.savedModelSelection("own")).toEqual(MODEL_SELECTIONS["claude-opus"]);
  });

  it("answers none for a subagent's session under the chat, or a session it does not know", async () => {
    const { settings, store } = await setup();
    store("subagent", storeSubagentParent(webchatSessionKey("chat-1")));
    expect(await settings.savedModelSelection("subagent")).toBeNull();
    expect(await settings.savedModelSelection("missing")).toBeNull();
  });
});
