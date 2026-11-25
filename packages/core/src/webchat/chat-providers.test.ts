import { describe, expect, it } from "@rstest/core";
import { createTestDb } from "../test/db.js";
import { reportOf } from "../test/kit/model-accounts.js";
import { ChatsWebChatRepository } from "./chats-webchat-repository.js";
import { MODEL_SELECTIONS } from "../agent/index.js";
import { createChatProviders, pinnedModelOf, selectionOfModel } from "./chat-providers.js";

async function setup(
  options: {
    lastModel?: Record<string, { providerId: string; model: string }>;
    tier?: "large" | "medium" | "small";
    /** The session keys that last ran on each provider. */
    ran?: Record<string, string[]>;
    settings?: Map<string, unknown>;
    currentDefault?: "anthropic" | "openai" | "rome_credits";
    /** Keys of other sessions that still exist, on any provider. */
    alive?: string[];
    /** Records the `since` each listing asked for. */
    asked?: Date[];
    /** Delays each settings write, so two changes overlap. */
    slowWrites?: boolean;
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
  await webchatRepo.updateSessionLargeModelSelection("fast", "anthropic/claude-sonnet-5-5", "auto");
  await said("fast");
  // Its owner picked the model.
  await webchatRepo.createSession(
    "picked",
    "Picked",
    undefined,
    undefined,
    "anthropic/claude-opus-5-5[1m]",
  );
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
        if (options.slowWrites) await new Promise((resolve) => setTimeout(resolve, 5));
        settings.set(key, structuredClone(value));
      },
    },
    currentDefault: () => options.currentDefault ?? "openai",
    // As the session store answers: every live conversation, whatever its last provider.
    ranSince: async (since) => {
      options.asked?.push(since);
      return Object.values(options.ran ?? {})
        .flat()
        .concat(options.alive ?? []);
    },
    now: () => new Date("2026-11-22T12:00:00.000Z"),
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
    expect(await row("plain")).toEqual({ selection: "anthropic/claude-opus-5-5[1m]", by: "kept" });
    expect(await row("fast")).toEqual({ selection: "anthropic/claude-sonnet-5-5", by: "kept" });
    expect(await row("picked")).toEqual({
      selection: "anthropic/claude-opus-5-5[1m]",
      by: "owner",
    });
    expect(await row("empty")).toEqual({ selection: null, by: null });
    expect(selected).toEqual([
      ["plain", "anthropic/claude-opus-5-5[1m]"],
      ["fast", "anthropic/claude-sonnet-5-5"],
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
    expect(await row("plain")).toEqual({ selection: "anthropic/claude-opus-5-5[1m]", by: "auto" });
    expect(await row("picked")).toEqual({
      selection: "anthropic/claude-opus-5-5[1m]",
      by: "owner",
    });
  });

  it("keeps one chat on another provider, never one its owner picked a model for", async () => {
    const { providers, row } = await setup();
    expect(await providers.keep("fast", "openai")).toBe("openai/gpt-6-luna");
    expect(await row("fast")).toEqual({ selection: "openai/gpt-6-luna", by: "kept" });
    expect(await providers.keep("picked", "openai")).toBeNull();
    await providers.follow("fast");
    expect(await row("fast")).toEqual({ selection: "openai/gpt-6-luna", by: "auto" });
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
    expect(await row("plain")).toEqual({ selection: "anthropic/claude-sonnet-5-5", by: "kept" });
  });

  it("is its agent's tier when the session never ran a model", async () => {
    const fast = await setup({ lastModel: {}, tier: "medium" });
    expect(await fast.providers.keep("plain", "anthropic")).toBe("anthropic/claude-sonnet-5-5");
    const strong = await setup({ lastModel: {}, tier: "large" });
    expect(await strong.providers.keep("plain", "anthropic")).toBe("anthropic/claude-opus-5-5[1m]");
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

  it("holds a fork whose id is a real uuid v7, and its subagents, but no one-off run", async () => {
    const fork = "webchat:019a8f2e-7c41-7d3a-9b1e-4f2c6a8d0e11";
    const { providers } = await setup({
      ran: {
        anthropic: [fork, `${fork}:subagent:abc`, "main:0b7e7a5e-3c1f-4c8e-9a51-2f4f6f3d9f10"],
      },
    });
    await providers.beforeDefaultChange(unchecked);
    expect(providers.heldProvider(fork)).toBe("anthropic");
    expect(providers.heldProvider(`${fork}:subagent:abc`)).toBe("anthropic");
    expect(providers.heldProvider("main:0b7e7a5e-3c1f-4c8e-9a51-2f4f6f3d9f10")).toBeUndefined();
  });

  it("holds a fork chat whose last turn ran on another provider on the old default, and reports it pinned", async () => {
    // As on the stack: a top-level fork chat (triggerKind fork, a parent chat,
    // no stored model) whose only turns ran on Codex before the default was Claude.
    const forkId = "01a1b2a1-2a30-7489-8e21-9dfe73454e96";
    const { providers } = await setup({ ran: { openai: [`webchat:${forkId}`] } });
    await providers.beforeDefaultChange(unchecked);
    expect(providers.heldProvider(`webchat:${forkId}`)).toBe("anthropic");
    // The chat APIs read it as pinned to Claude: a kept chat with no model of its own.
    expect(
      pinnedModelOf(
        { largeModelSelection: null, largeModelSelectionBy: null },
        providers.heldProvider(`webchat:${forkId}`),
      ),
    ).toEqual({ by: "kept", providerId: "anthropic", selection: null, model: null });
  });

  it("counts a fork chat among the chats a move would move, before and after it is held", async () => {
    const forkId = "01a1b2a1-2a30-7489-8e21-9dfe73454e96";
    const { providers, webchatRepo } = await setup({
      currentDefault: "anthropic",
      ran: { openai: [`webchat:${forkId}`] },
    });
    await webchatRepo.ensureRomeSession({
      id: forkId,
      type: "webchat",
      name: "Fork",
      agentName: null,
      trigger: { triggerKind: "fork", triggerName: "branch" },
      parentSessionId: "plain",
      parentTurnId: "t1",
    });
    // Two web chats that follow, and the fork.
    expect(await providers.followingCount()).toBe(3);
    await providers.beforeDefaultChange(unchecked);
    expect(await providers.followingCount()).toBe(3);
  });

  it("counts no chat its owner picked a model for, though it ran lately", async () => {
    const { providers } = await setup({ ran: { anthropic: ["webchat:picked"] } });
    expect(await providers.followingCount()).toBe(2);
  });

  it("keeps a held fork whose model Rome chose on the old default, so it does not follow the new one", async () => {
    const forkId = "01a1b2a2-867a-74bd-8a0b-eee3c7b7106d";
    const { providers, webchatRepo, row } = await setup({
      ran: { anthropic: [`webchat:${forkId}`] },
    });
    await webchatRepo.ensureRomeSession({
      id: forkId,
      type: "webchat",
      name: "Fork",
      agentName: null,
      trigger: { triggerKind: "concierge_fork", triggerName: "branch" },
      parentSessionId: "plain",
      parentTurnId: "t1",
    });
    // An older overload swap left Rome's choice on the fork.
    await webchatRepo.updateSessionLargeModelSelection(
      forkId,
      "anthropic/claude-sonnet-5-5",
      "auto",
    );
    await providers.beforeDefaultChange(unchecked);
    expect(await row(forkId)).toEqual({ selection: "anthropic/claude-sonnet-5-5", by: "kept" });
    expect(providers.heldProvider(`webchat:${forkId}`)).toBe("anthropic");
  });

  it("holds a chat kept from before, or its owner's pick, where its own model runs", async () => {
    const { providers, webchatRepo } = await setup({
      ran: { openai: ["webchat:old-kept", "webchat:picked"] },
    });
    await webchatRepo.createSession("old-kept", "Old kept");
    // Kept on ChatGPT under the old rule, with no held entry.
    await webchatRepo.updateSessionLargeModelSelection("old-kept", "openai/gpt-6.1-sol", "kept");
    await providers.beforeDefaultChange(unchecked);
    // Its subagents stay with it on ChatGPT, not on the old default.
    expect(providers.heldProvider("webchat:old-kept:subagent:abc")).toBe("openai");
    // The owner picked Claude Opus: its conversation is held on Claude.
    expect(providers.heldProvider("webchat:picked")).toBe("anthropic");
  });

  it("a model pick on another provider takes the hold there, so subagents follow the chat", async () => {
    const { providers, row, selected } = await setup();
    await providers.beforeDefaultChange(unchecked);
    expect(providers.heldProvider("webchat:fast:subagent:abc")).toBe("anthropic");
    await providers.pick("fast", "openai/gpt-6.1-sol");
    expect(await row("fast")).toEqual({ selection: "openai/gpt-6.1-sol", by: "owner" });
    expect(selected.at(-1)).toEqual(["fast", "openai/gpt-6.1-sol"]);
    expect(providers.heldProvider("webchat:fast")).toBe("openai");
    expect(providers.heldProvider("webchat:fast:subagent:abc")).toBe("openai");
    // Auto lets the conversation go.
    await providers.pick("fast", null);
    expect(providers.heldProvider("webchat:fast")).toBeUndefined();
    // A chat that is not held stays unheld.
    await providers.pick("empty", "openai/gpt-6.1-sol");
    expect(providers.heldProvider("webchat:empty")).toBeUndefined();
  });

  it("an owner's pick and a card's switch at once leave the chat and its hold agreeing", async () => {
    const { providers, row } = await setup({ slowWrites: true });
    await providers.beforeDefaultChange(unchecked);
    await Promise.all([
      providers.keep("fast", "anthropic"),
      providers.pick("fast", "openai/gpt-6.1-sol"),
    ]);
    const after = await row("fast");
    const on = MODEL_SELECTIONS[after.selection as "openai/gpt-6.1-sol"].providerId;
    // Whichever ran last, the parent's model and its subagents' hold name one provider.
    expect(providers.heldProvider("webchat:fast:subagent:abc")).toBe(on);
  });

  it("Back to default keeps a model-less fork's strength, from the model it last ran", async () => {
    const forkId = "01a1b2a1-2a30-7489-8e21-9dfe73454e96";
    const { providers, webchatRepo, row, selected } = await setup({
      currentDefault: "openai",
      tier: "large",
      ran: { anthropic: [`webchat:${forkId}`] },
      lastModel: { [forkId]: { providerId: "anthropic", model: "claude-sonnet-5-5" } },
    });
    await webchatRepo.ensureRomeSession({
      id: forkId,
      type: "webchat",
      name: "Fork",
      agentName: null,
      trigger: { triggerKind: "fork", triggerName: "branch" },
      parentSessionId: "plain",
      parentTurnId: "t1",
    });
    await providers.beforeDefaultChange({ ...unchecked, from: "anthropic", to: "openai" });
    expect(providers.heldProvider(`webchat:${forkId}`)).toBe("anthropic");
    // A Sonnet fork on a large-tier agent comes back as the fast model, not Sol.
    expect(await providers.follow(forkId)).toBe("openai/gpt-6-luna");
    expect(await row(forkId)).toEqual({ selection: "openai/gpt-6-luna", by: "auto" });
    expect(selected.at(-1)).toEqual([forkId, "openai/gpt-6-luna"]);
    expect(providers.heldProvider(`webchat:${forkId}`)).toBeUndefined();
  });

  it("holds only conversations active in the last 30 days", async () => {
    const asked: Date[] = [];
    const { providers } = await setup({ ran: { anthropic: ["telegram:42"] }, asked });
    await providers.beforeDefaultChange(unchecked);
    expect(asked[0]?.toISOString()).toBe("2026-10-23T12:00:00.000Z");
  });

  it("lets a held channel chat go once it has no session left", async () => {
    const ran = { anthropic: ["telegram:42"] } as Record<string, string[]>;
    const { providers } = await setup({ ran });
    await providers.beforeDefaultChange(unchecked);
    ran.anthropic = [];
    await providers.beforeDefaultChange({ ...unchecked, from: "openai", to: "anthropic" });
    expect(providers.heldProvider("telegram:42")).toBeUndefined();
  });

  it("lets a deleted chat's conversation go, and Auto in the model menu too", async () => {
    const { providers } = await setup({ ran: { anthropic: ["webchat:fork-1"] } });
    await providers.beforeDefaultChange(unchecked);
    await providers.release("fork-1");
    expect(providers.heldProvider("webchat:fork-1")).toBeUndefined();
  });

  it("drops no change when two changes of the held map overlap", async () => {
    const { providers, settings } = await setup({ slowWrites: true });
    await Promise.all([
      providers.keep("fast", "anthropic"),
      providers.keep("plain", "openai"),
      providers.release("picked"),
    ]);
    expect(providers.heldProvider("webchat:fast")).toBe("anthropic");
    expect(providers.heldProvider("webchat:plain")).toBe("openai");
    expect(settings.get("heldSessions")).toEqual({
      "webchat:fast": "anthropic",
      "webchat:plain": "openai",
    });
  });

  it("counts a channel chat that follows the default among the chats a move would move", async () => {
    const { providers } = await setup({
      currentDefault: "openai",
      ran: { openai: ["telegram:7"] },
    });
    // Two web chats that follow, and the channel's chat not held yet.
    expect(await providers.followingCount()).toBe(3);
  });

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
    const { providers } = await setup({
      ran: { anthropic: ["telegram:42"] },
      currentDefault: "openai",
    });
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
      pinnedModelOf({
        largeModelSelection: "anthropic/claude-haiku-5-5",
        largeModelSelectionBy: "owner",
      }),
    ).toMatchObject({
      by: "owner",
      providerId: "anthropic",
      selection: "anthropic/claude-haiku-5-5",
    });
    // A model stored before Rome recorded who chose it is its owner's.
    expect(
      pinnedModelOf({
        largeModelSelection: "anthropic/claude-haiku-5-5",
        largeModelSelectionBy: null,
      }),
    ).toMatchObject({
      by: "owner",
    });
    expect(
      pinnedModelOf({ largeModelSelection: "openai/gpt-6.1-sol", largeModelSelectionBy: "kept" }),
    ).toMatchObject({ by: "kept", providerId: "openai" });
    expect(pinnedModelOf({ largeModelSelection: null }, "anthropic")).toEqual({
      by: "kept",
      providerId: "anthropic",
      selection: null,
      model: null,
    });
    expect(
      pinnedModelOf({
        largeModelSelection: "anthropic/claude-opus-5-5[1m]",
        largeModelSelectionBy: "auto",
      }),
    ).toBeNull();
    expect(pinnedModelOf({ largeModelSelection: null })).toBeNull();
    // A model Rome chose, while its conversation is held: pinned there.
    expect(
      pinnedModelOf(
        { largeModelSelection: "anthropic/claude-opus-5-5[1m]", largeModelSelectionBy: "auto" },
        "anthropic",
      ),
    ).toMatchObject({
      by: "kept",
      providerId: "anthropic",
      selection: "anthropic/claude-opus-5-5[1m]",
    });
    expect(
      pinnedModelOf(
        { largeModelSelection: "openai/gpt-6.1-sol", largeModelSelectionBy: "auto" },
        "anthropic",
      ),
    ).toEqual({ by: "kept", providerId: "anthropic", selection: null, model: null });
  });

  it("Back to default lets a kept chat follow again, at its strength on the default", async () => {
    const { providers, row, selected } = await setup({ currentDefault: "openai" });
    await providers.keep("fast", "anthropic");
    expect(providers.heldProvider("webchat:fast")).toBe("anthropic");
    expect(await providers.follow("fast")).toBe("openai/gpt-6-luna");
    expect(await row("fast")).toEqual({ selection: "openai/gpt-6-luna", by: "auto" });
    expect(providers.heldProvider("webchat:fast")).toBeUndefined();
    expect(selected.at(-1)).toEqual(["fast", "openai/gpt-6-luna"]);
  });

  it("Back to default clears an owner's pick too", async () => {
    const { providers, row } = await setup({ currentDefault: "anthropic" });
    expect(await providers.follow("picked")).toBe("anthropic/claude-opus-5-5[1m]");
    expect(await row("picked")).toEqual({ selection: "anthropic/claude-opus-5-5[1m]", by: "auto" });
    expect(
      pinnedModelOf({
        largeModelSelection: "anthropic/claude-opus-5-5[1m]",
        largeModelSelectionBy: "auto",
      }),
    ).toBeNull();
  });

  it("Back to default does nothing for a chat that follows the default", async () => {
    const { providers, row } = await setup();
    expect(await providers.follow("fast")).toBeNull();
    expect(await row("fast")).toEqual({ selection: "anthropic/claude-sonnet-5-5", by: "auto" });
  });
});

it("does not match another provider or strip a context suffix when reversing an identity", () => {
  expect(selectionOfModel("claude-opus-4-8[1m]", "anthropic")).toBe(
    "anthropic/claude-opus-4-8[1m]",
  );
  expect(selectionOfModel("claude-opus-4-8[1m]", "openai")).toBeNull();
  expect(selectionOfModel("claude-opus-4-8", "anthropic")).toBeNull();
});

it.each([
  "claude-opus-5-5",
  "claude-sonnet-4-5-20250929",
])("holds off-catalog %s without changing its exact session pin or blocking other chats", async (model) => {
  const { providers, row, selected } = await setup({
    lastModel: { plain: { providerId: "anthropic", model } },
  });
  await providers.beforeDefaultChange({
    from: "anthropic",
    to: "openai",
    by: "guardian",
    moveExisting: false,
  });
  expect(await row("plain")).toEqual({ selection: null, by: null });
  expect(selected.some(([id]) => id === "plain")).toBe(false);
  expect(providers.heldProvider("webchat:plain")).toBe("anthropic");
  expect((await row("fast")).by).toBe("kept");
  await providers.beforeDefaultChange({
    from: "openai",
    to: "anthropic",
    by: "guardian",
    moveExisting: false,
  });
  expect(await row("plain")).toEqual({ selection: null, by: null });
  expect(providers.heldProvider("webchat:plain")).toBe("anthropic");
  expect(selected.some(([id]) => id === "plain")).toBe(false);
  await expect(providers.follow("plain")).resolves.not.toThrow();
  expect(providers.heldProvider("webchat:plain")).toBeUndefined();
});
