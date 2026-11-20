import { describe, expect, it } from "@rstest/core";
import { createTestDb } from "../test/db.js";
import { reportOf } from "../test/kit/model-accounts.js";
import { ChatsWebChatRepository } from "./chats-webchat-repository.js";
import { createChatProviders } from "./chat-providers.js";

async function setup(
  options: {
    lastModel?: Record<string, { providerId: string; model: string }>;
    tier?: "large" | "medium" | "small";
    signedIn?: { anthropic: boolean; openai: boolean };
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
  const selected: Array<[string, string | null]> = [];
  const credits: Array<[string, boolean | undefined]> = [];
  // The plain chat last ran Opus.
  const lastModel = options.lastModel ?? {
    plain: { providerId: "anthropic", model: "claude-opus-5-5[1m]" },
  };
  const accountListeners: Array<() => void> = [];
  const signedIn = options.signedIn ?? { anthropic: false, openai: false };
  const providers = createChatProviders({
    webchatRepo,
    accounts: {
      read: () => ({ openai: reportOf("available"), anthropic: reportOf("available") }),
      onChanged: (listener) => {
        accountListeners.push(() => listener("anthropic", "authorization", true));
        return () => undefined;
      },
    },
    signedIn: () => ({ ...signedIn, rome_credits: !signedIn.anthropic && !signedIn.openai }),
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
  const onCredits = async (id: string) => (await webchatRepo.getSession(id))?.romeCredits;
  /** An account changes, as a login does. */
  const accountsChanged = () => {
    for (const listener of accountListeners) listener();
  };
  return {
    providers,
    row,
    selected,
    credits,
    webchatRepo,
    onCredits,
    signedIn,
    accountsChanged,
  };
}

describe("which provider a chat that follows the default runs on", () => {
  it("counts only the chats a change of the default would move", async () => {
    const { providers } = await setup();
    expect(await providers.followingCount()).toBe(2);
  });

  it("counts kept chats too, which moving existing chats lets follow again, as Settings does", async () => {
    const { providers } = await setup();
    await providers.keep("fast", "openai");
    // "Move existing chats too" shows, and does the same, wherever a change
    // of the default asks it: one follower and one kept chat would move.
    expect(await providers.followingCount()).toBe(2);
    await providers.beforeDefaultChange({
      from: "anthropic",
      to: "openai",
      by: "guardian",
      moveExisting: true,
    });
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
    // Kept now: a later change that moves existing chats would move them again.
    expect(await providers.followingCount()).toBe(2);
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

describe("a chat on Rome credits", () => {
  it("is a flag beside its model: the model and who chose it stay", async () => {
    const { providers, row, credits, onCredits } = await setup();
    await providers.keep("fast", "rome_credits");
    expect(await row("fast")).toEqual({ selection: "claude-sonnet", by: "auto" });
    expect(await onCredits("fast")).toBe(true);
    expect(credits.at(-1)).toEqual(["fast", true]);
    await providers.follow("fast");
    expect(await row("fast")).toEqual({ selection: "claude-sonnet", by: "auto" });
    expect(await onCredits("fast")).toBe(false);
    expect(credits.at(-1)).toEqual(["fast", false]);
  });

  it("keeps a model its owner picked, which comes back and never follows the default", async () => {
    const { providers, row, onCredits } = await setup();
    await providers.keep("picked", "rome_credits");
    expect(await onCredits("picked")).toBe(true);
    expect(await row("picked")).toEqual({ selection: "claude-opus-5-5", by: "owner" });
    expect(await providers.releaseCredits()).toBe(1);
    expect(await row("picked")).toEqual({ selection: "claude-opus-5-5", by: "owner" });
    await providers.beforeDefaultChange({
      from: "anthropic",
      to: "openai",
      by: "guardian",
      moveExisting: true,
    });
    expect(await row("picked")).toEqual({ selection: "claude-opus-5-5", by: "owner" });
  });

  it("ends for every chat once any AI account logs in", async () => {
    const { providers, onCredits, signedIn, accountsChanged, credits } = await setup();
    await providers.keep("fast", "rome_credits");
    await providers.keep("picked", "rome_credits");
    // An account read while none is logged in leaves them on credits.
    accountsChanged();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await onCredits("fast")).toBe(true);
    signedIn.openai = true;
    accountsChanged();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await onCredits("fast")).toBe(false);
    expect(await onCredits("picked")).toBe(false);
    expect(credits.slice(-2)).toEqual([
      ["fast", false],
      ["picked", false],
    ]);
  });

  it("survives a model its owner picks from the composer", async () => {
    const { providers, webchatRepo, onCredits, row } = await setup();
    await providers.keep("fast", "rome_credits");
    await webchatRepo.updateSessionLargeModelSelection("fast", "claude-opus-5-5", "owner");
    expect(await onCredits("fast")).toBe(true);
    expect(await row("fast")).toEqual({ selection: "claude-opus-5-5", by: "owner" });
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

  it("writes nothing, and says so, for a message not written yet", async () => {
    const { webchatRepo } = await setup();
    expect(
      await webchatRepo.updateMessageContent(
        "not-written-yet",
        JSON.stringify([{ type: "text", content: "x" }]),
      ),
    ).toBe(false);
  });
});
