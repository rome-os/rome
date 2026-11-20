import { describe, expect, it } from "@rstest/core";
import { createTestDb } from "../test/db.js";
import { reportOf } from "../test/kit/model-accounts.js";
import { ChatsWebChatRepository } from "./chats-webchat-repository.js";
import { createChatProviders } from "./chat-providers.js";

async function setup() {
  const testDb = createTestDb();
  const webchatRepo = new ChatsWebChatRepository(testDb.db);
  const said = async (id: string) =>
    webchatRepo.addMessage(
      `${id}-m`,
      id,
      "user",
      JSON.stringify([{ type: "text", content: "hi" }]),
    );
  // Follows the default: no model stored.
  await webchatRepo.createSession("plain", "Plain");
  await said("plain");
  // Follows the default at the fast strength Rome chose.
  await webchatRepo.createSession("fast", "Fast");
  await webchatRepo.updateSessionLargeModelSelection("fast", "claude-sonnet", "auto");
  await said("fast");
  // Its owner picked the model.
  await webchatRepo.createSession("picked", "Picked", undefined, undefined, "claude-opus-5-5");
  await said("picked");
  // Never said anything.
  await webchatRepo.createSession("empty", "Empty");
  const selected: Array<[string, string]> = [];
  const providers = createChatProviders({
    webchatRepo,
    accounts: { read: () => ({ openai: reportOf("available"), anthropic: reportOf("available") }) },
    selectModel: (chatId, _agentName, selection) => selected.push([chatId, selection]),
  });
  const row = async (id: string) => {
    const chat = await webchatRepo.getSession(id);
    return { selection: chat?.largeModelSelection, by: chat?.largeModelSelectionBy };
  };
  return { providers, row, selected, webchatRepo };
}

describe("which provider a chat that follows the default runs on", () => {
  it("counts only the chats a change of the default would move", async () => {
    const { providers } = await setup();
    expect(await providers.followingCount()).toBe(2);
  });

  it("keeps the chats on the old default, at their strength, when they do not move", async () => {
    const { providers, row, selected } = await setup();
    await providers.beforeDefaultChange({
      from: "anthropic",
      to: "openai",
      by: "guardian",
      moveExisting: false,
    });
    expect(await row("plain")).toEqual({ selection: "claude-opus-5-5", by: "kept" });
    expect(await row("fast")).toEqual({ selection: "claude-sonnet", by: "kept" });
    expect(await row("picked")).toEqual({ selection: "claude-opus-5-5", by: "owner" });
    expect(await row("empty")).toEqual({ selection: null, by: null });
    expect(selected).toEqual([
      ["plain", "claude-opus-5-5"],
      ["fast", "claude-sonnet"],
    ]);
    expect(await providers.followingCount()).toBe(0);
  });

  it("lets every kept chat follow again when the default moves the chats", async () => {
    const { providers, row } = await setup();
    await providers.beforeDefaultChange({
      from: "anthropic",
      to: "openai",
      by: "guardian",
      moveExisting: false,
    });
    await providers.beforeDefaultChange({
      from: "openai",
      to: "anthropic",
      by: "guardian",
      moveExisting: true,
    });
    expect(await row("plain")).toEqual({ selection: "claude-opus-5-5", by: "auto" });
    expect(await row("picked")).toEqual({ selection: "claude-opus-5-5", by: "owner" });
  });

  it("keeps one chat on another provider, never one its owner picked a model for", async () => {
    const { providers, row } = await setup();
    expect(await providers.keep("fast", "openai")).toBe("gpt-6-luna");
    expect(await row("fast")).toEqual({ selection: "gpt-6-luna", by: "kept" });
    expect(await providers.keep("picked", "openai")).toBeNull();
    await providers.follow("fast");
    expect(await row("fast")).toEqual({ selection: "gpt-6-luna", by: "auto" });
  });
});

describe("a card rewritten in place", () => {
  it("rewrites the line in its chat and tells the chat's live view", async () => {
    const { webchatRepo } = await setup();
    const message = await webchatRepo.addBackendMessage("plain", "turn-1", [
      { type: "text", content: "before" },
    ]);
    const updated: Array<{ id: string; sessionId: string; content: string }> = [];
    webchatRepo.onMessageUpdated((m) => updated.push(m));
    await webchatRepo.updateMessageContent(
      message.id,
      JSON.stringify([{ type: "text", content: "after" }]),
    );
    const lines = await webchatRepo.getMessages("plain");
    expect(lines.find((line) => line.id === message.id)?.content).toContain("after");
    expect(updated).toEqual([expect.objectContaining({ id: message.id, sessionId: "plain" })]);
    expect(updated[0]?.content).toContain("after");
  });
});
