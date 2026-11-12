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
