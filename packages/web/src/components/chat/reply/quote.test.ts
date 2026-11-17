import { describe, expect, it } from "@rstest/core";
import type { ConciergeItem } from "@/components/chat/concierge-groups";
import type { ChatMessage } from "@/lib/chat-types";
import { adjacentReplies } from "./adjacency";
import { quoteLine } from "./reply-source";

describe("the line a quote shows", () => {
  it("is the first line of the quoted message with text, as plain reading text", () => {
    expect(quoteLine("Yes, €200 minimum.\n\n> Back room: €200\n> Main room: none")).toBe(
      "Yes, €200 minimum.",
    );
    expect(quoteLine("## Plan Kyoto\nthen the hotels")).toBe("Plan Kyoto");
    expect(quoteLine("\n\n**Booked** it")).toBe("Booked it");
  });

  it("skips the fence of a code block, and is empty for a message with no words", () => {
    expect(quoteLine("```py\nx = 1\n```")).toBe("x = 1");
    expect(quoteLine("   \n")).toBe("");
  });
});

const reply = (id: string, replyTo?: string): ChatMessage =>
  ({
    id,
    sessionId: "s",
    turnId: null,
    role: "assistant",
    content: JSON.stringify([
      ...(replyTo
        ? [{ type: "reply_to", messageId: replyTo, author: "agent", text: replyTo }]
        : []),
      { type: "text", content: id },
    ]),
    createdAt: "2026-11-09T09:00:00.000Z",
  }) as ChatMessage;

const group = (sender: "guardian" | "agent", ...messages: ChatMessage[]): ConciergeItem => ({
  kind: "group",
  key: messages[0]!.id,
  sender,
  entries: messages.map((message) => ({ message, endsTurn: false })),
  typing: false,
});
const separator: ConciergeItem = { kind: "separator", key: "sep", at: "2026-11-09T10:00:00.000Z" };

describe("adjacent replies", () => {
  it("counts a reply to the message right above it, whoever said either", () => {
    const items = [group("guardian", reply("q")), group("agent", reply("a", "q"))];
    expect([...adjacentReplies(items)]).toEqual(["a"]);
    // An owner reply to the agent's message above.
    const chain = [...items, group("guardian", reply("r", "a"))];
    expect([...adjacentReplies(chain)]).toEqual(["a", "r"]);
  });

  it("counts replies to the same message that follow each other, across groups and senders", () => {
    const items = [
      group("guardian", reply("q")),
      group("agent", reply("a", "q"), reply("b", "q"), reply("c", "q")),
      group("agent", reply("d", "q")),
    ];
    expect([...adjacentReplies(items)]).toEqual(["a", "b", "c", "d"]);
    // A time line between the groups is no message.
    const split = [items[0]!, items[1]!, separator, items[2]!];
    expect(adjacentReplies(split).has("d")).toBe(true);
    const across = [
      group("agent", reply("q")),
      group("guardian", reply("a", "q")),
      group("agent", reply("b", "q")),
    ];
    expect([...adjacentReplies(across)]).toEqual(["a", "b"]);
  });

  it("leaves a reply with a message between it and its target, and a message that replies to nothing, plain", () => {
    const items = [
      group("guardian", reply("q")),
      group("agent", reply("x")),
      group("agent", reply("a", "q")),
    ];
    expect(adjacentReplies(items).size).toBe(0);
  });

  it("judges on what the focus leaves visible", () => {
    const items = [
      group("guardian", reply("q")),
      group("agent", reply("x")),
      group("agent", reply("a", "q")),
    ];
    expect(adjacentReplies(items, new Set(["x"])).has("a")).toBe(true);
  });
});
