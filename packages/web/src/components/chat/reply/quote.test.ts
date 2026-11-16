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
  it("hooks a reply to the message right above it, whoever said either", () => {
    const items = [group("guardian", reply("q")), group("agent", reply("a", "q"))];
    expect(adjacentReplies(items)).toEqual(new Map([["a", { kind: "hook" }]]));
    // An owner reply to the agent's message above.
    const chain = [...items, group("guardian", reply("r", "a"))];
    expect([...adjacentReplies(chain).keys()]).toEqual(["a", "r"]);
  });

  it("joins replies of one sender to the same message with a line after the first, which keeps its hook", () => {
    const items = [
      group("guardian", reply("q")),
      group("agent", reply("a", "q"), reply("b", "q"), reply("c", "q")),
    ];
    expect(adjacentReplies(items)).toEqual(
      new Map([
        ["a", { kind: "hook" }],
        ["b", { kind: "line", gap: 8 }],
        ["c", { kind: "line", gap: 8 }],
      ]),
    );
  });

  it("spans the larger gap between two groups, and not a time line or another sender", () => {
    const next = [
      group("guardian", reply("q")),
      group("agent", reply("a", "q")),
      group("agent", reply("b", "q")),
    ];
    expect(adjacentReplies(next).get("b")).toEqual({ kind: "line", gap: 16 });
    // A time line between the groups is no message, so the reply is still adjacent, but not joined by a line.
    const split = [next[0]!, next[1]!, separator, next[2]!];
    expect(adjacentReplies(split).get("b")).toEqual({ kind: "hook" });
    // Another sender's reply to the same message sits on the other side.
    const across = [
      group("agent", reply("q")),
      group("guardian", reply("a", "q")),
      group("agent", reply("b", "q")),
    ];
    expect(adjacentReplies(across).get("b")).toEqual({ kind: "hook" });
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
    expect(adjacentReplies(items, new Set(["x"])).get("a")).toEqual({ kind: "hook" });
  });
});
