import { describe, expect, it } from "@rstest/core";
import { createRenewalHandoffs, recentMessagesOf, type ChatRow } from "./renewal-handoffs.js";
import type { ModelResolver } from "../agent/index.js";

const row = (role: string, text: string, turnId: string | null): ChatRow => ({
  role,
  content: JSON.stringify([{ type: "text", content: text }]),
  turnId,
  createdAt: new Date(0),
});

const unusedResolver: ModelResolver = {
  resolve: async () => {
    throw new Error("no model in this test");
  },
};

describe("recentMessagesOf", () => {
  it("names who said each line, and leaves out traces and the running turn's rows", () => {
    const rows = [
      row("user", "Book dinner", "t1"),
      row("assistant", "Booked for 7", "t1"),
      row("trace", "[]", "t1"),
      row("user", "Thanks", "t2"),
    ];
    expect(recentMessagesOf(rows, "t2").map((m) => `${m.senderName}: ${m.text}`)).toEqual([
      "Guardian: Book dinner",
      "You: Booked for 7",
    ]);
  });
});

describe("recentMessagesOf with an owner", () => {
  it("names the owner's lines as the chat's owner, and Rome's as before", () => {
    const rows = [row("user", "Book dinner", "t1"), row("assistant", "Done", "t1")];
    expect(recentMessagesOf(rows, undefined, "Visitor (Ana)").map((m) => m.senderName)).toEqual([
      "Visitor (Ana)",
      "You",
    ]);
  });
});

describe("createRenewalHandoffs", () => {
  it("reads the open tasks and recent messages a successor's first turn shows", async () => {
    const handoffs = createRenewalHandoffs({
      timeoutMs: 30_000,
      fallbackTimeoutMs: 30_000,
      modelResolver: unusedResolver,
      rows: async () => [row("user", "Book dinner", "t1"), row("user", "Now?", "t2")],
      openTasks: async () => "- t-1 · Book dinner · active",
    });
    const context = await handoffs.context("chat-1", "t2");
    expect(context.openTasks).toBe("- t-1 · Book dinner · active");
    expect(context.recent.map((m) => m.text)).toEqual(["Book dinner"]);
  });

  it("writes no fallback for a session in no chat, or a chat with nothing said", async () => {
    const handoffs = createRenewalHandoffs({
      timeoutMs: 30_000,
      fallbackTimeoutMs: 30_000,
      modelResolver: unusedResolver,
      rows: async () => [],
      openTasks: async () => null,
    });
    expect(await handoffs.fallback(undefined, "concierge")).toBeNull();
    expect(await handoffs.fallback("chat-1", "concierge")).toBeNull();
  });

  it("gives up on the small model at its deadline, even when its session never closes", async () => {
    const stalled: ModelResolver = {
      resolve: async () =>
        ({
          model: "small",
          modelProvider: {
            id: "mock",
            openSession: async () => ({
              events: (async function* () {
                await new Promise(() => {});
              })(),
              sendUserInput: async () => {},
              interrupt: async () => {},
              close: () => new Promise<void>(() => {}),
            }),
          },
        }) as never,
    };
    const handoffs = createRenewalHandoffs({
      timeoutMs: 30_000,
      fallbackTimeoutMs: 20,
      modelResolver: stalled,
      rows: async () => [row("user", "dinner at 7", "t1")],
      openTasks: async () => null,
    });
    const started = Date.now();
    await expect(handoffs.fallback("chat-1", "concierge")).rejects.toThrow(/timed out/);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("says the chat is tidying up while a handoff is written, and only for a chat", async () => {
    const tidied: string[] = [];
    const handoffs = createRenewalHandoffs({
      timeoutMs: 30_000,
      fallbackTimeoutMs: 30_000,
      modelResolver: unusedResolver,
      rows: async () => [],
      openTasks: async () => null,
      tidying: async (chatId, work) => {
        tidied.push(chatId);
        return work();
      },
    });
    expect(await handoffs.tidying("chat-1", async () => "note")).toBe("note");
    expect(await handoffs.tidying(undefined, async () => "none")).toBe("none");
    expect(tidied).toEqual(["chat-1"]);
  });
});
