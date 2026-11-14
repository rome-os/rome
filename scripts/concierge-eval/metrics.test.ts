import { describe, expect, it } from "@rstest/core";
import { type MessageRow, chatMetrics, isAck, isEcho, kindOf } from "./metrics.js";

let n = 0;
const row = (at: number, parts: unknown[], agent: string | null = "core:concierge"): MessageRow => {
  const text = parts.map((p) => (p as { content?: string }).content ?? "").join("");
  n += 1;
  return {
    key: `m${n}`,
    sender_agent: agent,
    text,
    parts: JSON.stringify(parts),
    said_at: at,
    chat_thread_id: null,
  };
};
const say = (at: number, content: string) => row(at, [{ type: "text", content }]);
const owner = (at: number, content: string) => row(at, [{ type: "text", content }], null);

describe("kindOf", () => {
  it("tells cards, forwards and says apart", () => {
    expect(kindOf(row(0, [{ type: "task_chat", show: "task" }]))).toBe("task_card");
    expect(kindOf(row(0, [{ type: "task_chat", show: "ask" }]))).toBe("ask_card");
    expect(kindOf(row(0, [{ type: "pending_interaction" }]))).toBe("own_ask");
    expect(kindOf(row(0, [{ type: "text", content: "x", forwardedFrom: { chatId: "t" } }]))).toBe(
      "forward",
    );
    expect(kindOf(say(0, "hi"))).toBe("say");
  });
});

describe("isEcho", () => {
  const picked = { at: 0, words: ["Apple"] };
  it("flags a short message that names the owner's pick", () => {
    expect(isEcho("Apple it is.", picked)).toBe(true);
    expect(isEcho("You chose tea.", { at: 0, words: ["Tea"] })).toBe(true);
  });
  it("flags a restated decision", () => {
    expect(isEcho("The file was not written, as requested.", { at: 0, words: ["rejected"] })).toBe(
      true,
    );
  });
  it("passes news, and anything long", () => {
    expect(isEcho("Saved 3 recipes to recipes.md.", picked)).toBe(false);
    expect(isEcho(`Apple ${"x".repeat(220)}`, picked)).toBe(false);
  });
  it("passes a message that carries the expected result", () => {
    expect(isEcho("Apple: 12 calories per slice.", picked, [/calories/])).toBe(false);
  });
});

describe("isAck", () => {
  it("flags acknowledgements and announcements", () => {
    expect(isAck("Got it — on it.")).toBe(true);
    expect(isAck("I'll add it to your list.")).toBe(true);
    expect(isAck("好的，我来查")).toBe(true);
  });
  it("passes an answer", () => {
    expect(isAck("It's 18°C and sunny in Tokyo.")).toBe(false);
  });
});

describe("chatMetrics", () => {
  it("counts per owner message, bursts and silent turns", () => {
    const m = chatMetrics({
      messages: [
        owner(0, "pick a fruit task"),
        row(5, [{ type: "task_chat", show: "task" }]),
        row(30, [{ type: "task_chat", show: "ask" }]),
        say(100, "Apple it is."),
        owner(200, "thanks"),
        say(210, "Anytime."),
      ],
      turns: [
        { turn_id: "a", input_tokens: 100, output_tokens: 10, cache_read_tokens: 0, created_at: 0 },
        { turn_id: "b", input_tokens: 300, output_tokens: 30, cache_read_tokens: 0, created_at: 1 },
      ],
      speakingTurns: new Set(["a"]),
      outcomes: [{ at: 90, words: ["Apple"] }],
    });
    expect(m.ownerMessages).toBe(2);
    expect(m.conciergeMessages).toBe(4);
    expect(m.perOwnerMessage).toBe(2);
    expect(m.byKind.task_card).toBe(1);
    expect(m.echoes).toBe(1);
    expect(m.bursts).toBe(1);
    expect(m.messagesInBursts).toBe(2);
    expect(m.silentTurns).toBe(1);
    expect(m.inputTokens.mean).toBe(200);
  });

  it("ends a burst at the owner's card answer", () => {
    const m = chatMetrics({
      messages: [owner(0, "task"), row(10, [{ type: "task_chat", show: "ask" }]), say(40, "Done.")],
      turns: [],
      speakingTurns: new Set(),
      outcomes: [{ at: 20, words: ["Tea"] }],
    });
    expect(m.bursts).toBe(0);
  });

  it("does not count a card's answer as the owner's message", () => {
    const m = chatMetrics({
      messages: [owner(0, "hi"), row(1, [{ type: "interaction_result" }], null), say(2, "Hey.")],
      turns: [],
      speakingTurns: new Set(),
      outcomes: [],
    });
    expect(m.ownerMessages).toBe(1);
  });
});
