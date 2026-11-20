import { describe, expect, it } from "@rstest/core";
import { createTestDb } from "../test/db.js";
import { reportOf } from "../test/kit/model-accounts.js";
import { ChatsWebChatRepository } from "./chats-webchat-repository.js";
import { createChatProviders } from "./chat-providers.js";

async function setup(
  options: {
    lastModel?: Record<string, { providerId: string; model: string }>;
    tier?: "large" | "medium" | "small";
  } = {},
) {
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
  const credits: Array<[string, boolean | undefined]> = [];
  // The plain chat last ran Opus.
  const lastModel = options.lastModel ?? {
    plain: { providerId: "anthropic", model: "claude-opus-5-5[1m]" },
  };
  const providers = createChatProviders({
    webchatRepo,
    accounts: { read: () => ({ openai: reportOf("available"), anthropic: reportOf("available") }) },
    selectModel: (chatId, _agentName, selection, onCredits) => {
      selected.push([chatId, selection]);
      credits.push([chatId, onCredits]);
    },
    lastModel: async (chatId) => lastModel[chatId] ?? null,
    agentTier: () => options.tier,
  });
  const row = async (id: string) => {
    const chat = await webchatRepo.getSession(id);
    return { selection: chat?.largeModelSelection, by: chat?.largeModelSelectionBy };
  };
  return { providers, row, selected, credits, webchatRepo };
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

describe("the model a kept chat stays on", () => {
  it("is the model its session last ran, on the old provider or at its strength on another", async () => {
    const { providers, row } = await setup({
      lastModel: { plain: { providerId: "openai", model: "gpt-6-luna" } },
    });
    await providers.beforeDefaultChange({
      from: "anthropic",
      to: "openai",
      by: "guardian",
      moveExisting: false,
    });
    // It ran the fast model, so it stays fast: never "strong" because it was kept.
    expect(await row("plain")).toEqual({ selection: "claude-sonnet", by: "kept" });
  });

  it("is its agent's tier when the session never ran a model", async () => {
    const fast = await setup({ lastModel: {}, tier: "medium" });
    expect(await fast.providers.keep("plain", "anthropic")).toBe("claude-sonnet");
    const strong = await setup({ lastModel: {}, tier: "large" });
    expect(await strong.providers.keep("plain", "anthropic")).toBe("claude-opus-5-5");
  });
});

describe("a chat kept on Rome credits", () => {
  it("is marked as spending them until it follows the default again", async () => {
    const { providers, row, credits, webchatRepo } = await setup();
    expect(await providers.keep("fast", "rome_credits")).toBe("gpt-6-luna");
    expect(await row("fast")).toEqual({ selection: "gpt-6-luna", by: "credits" });
    expect(credits.at(-1)).toEqual(["fast", true]);
    await providers.follow("fast");
    expect(await row("fast")).toEqual({ selection: "gpt-6-luna", by: "auto" });
    expect(credits.at(-1)).toEqual(["fast", false]);
    // Moving every chat with a default change releases one on credits too.
    await providers.keep("fast", "rome_credits");
    await providers.beforeDefaultChange({
      from: "rome_credits",
      to: "anthropic",
      by: "guardian",
      moveExisting: true,
    });
    expect((await webchatRepo.getSession("fast"))?.largeModelSelectionBy).toBe("auto");
    expect(credits.at(-1)).toEqual(["fast", false]);
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
