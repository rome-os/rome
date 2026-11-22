import { describe, expect, it } from "@rstest/core";
import { createTestDb } from "../test/db.js";
import { reportOf } from "../test/kit/model-accounts.js";
import { ChatsWebChatRepository } from "./chats-webchat-repository.js";
import { createChatProviders, pinnedModelOf } from "./chat-providers.js";

async function setup(
  options: {
    lastModel?: Record<string, { providerId: string; model: string }>;
    tier?: "large" | "medium" | "small";
    /** The session keys that last ran on each provider. */
    ran?: Record<string, string[]>;
    settings?: Map<string, unknown>;
    currentDefault?: "anthropic" | "openai" | "rome_credits";
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
  const settings = options.settings ?? new Map<string, unknown>();
  // The plain chat last ran Opus.
  const lastModel = options.lastModel ?? {
    plain: { providerId: "anthropic", model: "claude-opus-5-5[1m]" },
  };
  const providers = createChatProviders({
    webchatRepo,
    accounts: {
      read: () => ({ openai: reportOf("available"), anthropic: reportOf("available") }),
    },
    selectModel: (chatId, _agentName, selection) => {
      selected.push([chatId, selection]);
    },
    lastModel: async (chatId) => lastModel[chatId] ?? null,
    agentTier: () => options.tier,
    settings: {
      get: async (key: string) => (settings.get(key) ?? null) as never,
      set: async (key: string, value: unknown) => {
        settings.set(key, structuredClone(value));
      },
    },
    currentDefault: () => options.currentDefault ?? "openai",
    ranOn: async (provider) => options.ran?.[provider] ?? [],
  });
  await providers.ready();
  const row = async (id: string) => {
    const chat = await webchatRepo.getSession(id);
    return { selection: chat?.largeModelSelection, by: chat?.largeModelSelectionBy };
  };
  return { providers, row, selected, webchatRepo, settings };
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

describe("a chat that moved on since a request", () => {
  it("has a person's newer message, or is gone", async () => {
    const { webchatRepo } = await setup();
    const before = Date.now() - 60_000;
    // "plain" holds a message said just now.
    expect(webchatRepo.chatMovedOnSince("plain", before)).toBe(true);
    expect(webchatRepo.chatMovedOnSince("plain", Date.now() + 60_000)).toBe(false);
    expect(webchatRepo.chatMovedOnSince("gone", before)).toBe(true);
  });
});

describe("an unchecked move keeps every existing chat", () => {
  const unchecked = {
    from: "anthropic",
    to: "openai",
    by: "guardian",
    moveExisting: false,
  } as const;

  it("holds a fork, a channel's chat and the subagents under any chat on the old provider", async () => {
    const { providers } = await setup({
      ran: {
        anthropic: [
          "webchat:fork-1",
          "telegram:42",
          // A subagent under a web chat, and a one-off run nobody resumes.
          "webchat:plain:subagent:abc",
          "main:0b7e7a5e-3c1f-4c8e-9a51-2f4f6f3d9f10",
        ],
      },
    });
    await providers.beforeDefaultChange(unchecked);
    expect(providers.heldProvider("webchat:fork-1")).toBe("anthropic");
    expect(providers.heldProvider("telegram:42")).toBe("anthropic");
    expect(providers.heldProvider("webchat:plain")).toBe("anthropic");
    expect(providers.heldProvider("main:0b7e7a5e-3c1f-4c8e-9a51-2f4f6f3d9f10")).toBeUndefined();
  });

  it("keeps what it held across a restart", async () => {
    const settings = new Map<string, unknown>();
    const first = await setup({ ran: { anthropic: ["telegram:42"] }, settings });
    await first.providers.beforeDefaultChange(unchecked);
    const again = await setup({ settings });
    expect(again.providers.heldProvider("telegram:42")).toBe("anthropic");
  });

  it("a checked move releases every held conversation", async () => {
    const { providers } = await setup({ ran: { anthropic: ["telegram:42"] } });
    await providers.beforeDefaultChange(unchecked);
    await providers.beforeDefaultChange({ ...unchecked, moveExisting: true });
    expect(providers.heldProvider("telegram:42")).toBeUndefined();
    expect(providers.heldProvider("webchat:plain")).toBeUndefined();
  });

  it("counts a held channel chat among the chats a checked move would move", async () => {
    const { providers } = await setup({ ran: { anthropic: ["telegram:42"] } });
    await providers.beforeDefaultChange(unchecked);
    // Two web chats kept, and the channel's chat.
    expect(await providers.followingCount()).toBe(3);
  });

  it("holds nothing on Rome credits: a login always moves every chat", async () => {
    const { providers } = await setup({ ran: { openai: ["telegram:42"] } });
    await providers.beforeDefaultChange({ ...unchecked, from: "rome_credits", to: "anthropic" });
    expect(providers.heldProvider("telegram:42")).toBeUndefined();
  });
});

describe("a pinned chat always reports it is pinned", () => {
  it("reports an owner's pick, a kept chat and a held fork, and nothing for Rome's choice", () => {
    expect(
      pinnedModelOf({ largeModelSelection: "claude-haiku", largeModelSelectionBy: "owner" }),
    ).toMatchObject({ by: "owner", providerId: "anthropic", selection: "claude-haiku" });
    // A model stored before Rome recorded who chose it is its owner's.
    expect(
      pinnedModelOf({ largeModelSelection: "claude-haiku", largeModelSelectionBy: null }),
    ).toMatchObject({
      by: "owner",
    });
    expect(
      pinnedModelOf({ largeModelSelection: "gpt-6-1-sol", largeModelSelectionBy: "kept" }),
    ).toMatchObject({ by: "kept", providerId: "openai" });
    expect(pinnedModelOf({ largeModelSelection: null }, "anthropic")).toEqual({
      by: "kept",
      providerId: "anthropic",
      selection: null,
      model: null,
    });
    expect(
      pinnedModelOf({ largeModelSelection: "claude-opus-5-5", largeModelSelectionBy: "auto" }),
    ).toBeNull();
    expect(pinnedModelOf({ largeModelSelection: null })).toBeNull();
  });

  it("Back to default lets a kept chat follow again, at its strength on the default", async () => {
    const { providers, row, selected } = await setup({ currentDefault: "openai" });
    await providers.keep("fast", "anthropic");
    expect(providers.heldProvider("webchat:fast")).toBe("anthropic");
    expect(await providers.follow("fast")).toBe("gpt-6-luna");
    expect(await row("fast")).toEqual({ selection: "gpt-6-luna", by: "auto" });
    expect(providers.heldProvider("webchat:fast")).toBeUndefined();
    expect(selected.at(-1)).toEqual(["fast", "gpt-6-luna"]);
  });

  it("Back to default clears an owner's pick too", async () => {
    const { providers, row } = await setup({ currentDefault: "anthropic" });
    expect(await providers.follow("picked")).toBe("claude-opus-5-5");
    expect(await row("picked")).toEqual({ selection: "claude-opus-5-5", by: "auto" });
    expect(
      pinnedModelOf({ largeModelSelection: "claude-opus-5-5", largeModelSelectionBy: "auto" }),
    ).toBeNull();
  });

  it("Back to default does nothing for a chat that follows the default", async () => {
    const { providers, row } = await setup();
    expect(await providers.follow("fast")).toBeNull();
    expect(await row("fast")).toEqual({ selection: "claude-sonnet", by: "auto" });
  });
});
