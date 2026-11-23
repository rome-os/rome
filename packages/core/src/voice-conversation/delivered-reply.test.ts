import { describe, expect, it } from "@rstest/core";
import type { StreamAgentEvent } from "@rome-os/app-runtime";
import type { ReplyEvent } from "./conversation.js";
import { type AddedMessage, gatherDelivered } from "./delivered-reply.js";

/** A chat whose added messages the test announces. */
function chat() {
  const listeners = new Set<(message: AddedMessage) => void>();
  return {
    listening: () => listeners.size,
    subscribe: (listener: (message: AddedMessage) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    add(turnId: string, parts: object[], role = "assistant") {
      for (const listener of listeners) listener({ turnId, role, content: JSON.stringify(parts) });
    },
  };
}

/** A turn whose events the test pushes, until it ends. */
function turn(id: string) {
  const events: StreamAgentEvent[] = [];
  let ended = false;
  let wake = () => {};
  return {
    id,
    events: () => ({
      async *[Symbol.asyncIterator]() {
        let next = 0;
        while (true) {
          while (next < events.length) yield events[next++] as StreamAgentEvent;
          if (ended) return;
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        }
      },
    }),
    push(event: StreamAgentEvent) {
      events.push(event);
      wake();
    },
    end() {
      ended = true;
      wake();
    },
  };
}

async function all(events: AsyncIterable<ReplyEvent>): Promise<ReplyEvent[]> {
  const seen: ReplyEvent[] = [];
  for await (const event of events) seen.push(event);
  return seen;
}

describe("a reply delivered as messages", () => {
  it("says the turn's messages and shows its cards, never its private text", async () => {
    const room = chat();
    const delivered = gatherDelivered(room.subscribe);
    // A message can come before the send hands back its turn.
    room.add("t1", [{ type: "text", content: "好的，我来订。" }]);
    const answering = turn("t1");
    const seen = all(delivered.of(answering).events());
    await new Promise((resolve) => setTimeout(resolve, 0));

    answering.push({ type: "text_delta", content: "thinking aloud" });
    answering.push({ type: "tool_use", id: "c1", tool: "mcp__rome__say", input: {} });
    room.add("t1", [
      { type: "reply_to", messageId: "m1", author: "guardian", text: "订票" },
      { type: "text", content: "已订好下午的航班。" },
    ]);
    room.add("t1", [{ type: "widget", appId: "core", ui: {} }]);
    room.add("t2", [{ type: "text", content: "别的对话" }]);
    room.add("t1", [{ type: "text", content: "我自己的话" }], "user");
    answering.push({ type: "text", content: "done" });
    answering.end();

    const events = await seen;
    // The messages, in the order they were added, and the turn's events that are not its text.
    expect(events.filter((e) => e.type === "said" || e.type === "shown")).toEqual([
      { type: "said", text: "好的，我来订。" },
      { type: "said", text: "已订好下午的航班。" },
      { type: "shown" },
    ]);
    expect(events.filter((e) => e.type !== "said" && e.type !== "shown")).toEqual([
      { type: "tool_use", id: "c1", tool: "mcp__rome__say", input: {} },
    ]);
    expect(room.listening()).toBe(0);
  });

  it("stops gathering for a send that started no turn", () => {
    const room = chat();
    const delivered = gatherDelivered(room.subscribe);
    expect(room.listening()).toBe(1);
    delivered.stop();
    expect(room.listening()).toBe(0);
  });
});
