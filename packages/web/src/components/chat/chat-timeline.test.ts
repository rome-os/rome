import { describe, expect, it } from "@rstest/core";
import type { ChatMessage } from "@/lib/chat-types";
import {
  buildTimelineQuestions,
  layoutTimelineNodes,
  sameNodes,
  shouldShowTimeline,
  summarizeQuestion,
} from "./chat-timeline";

const MAIN = "main";
const CHILD = "child";

let seq = 0;
function msg(role: ChatMessage["role"], sessionId: string, blocks: unknown[]): ChatMessage {
  seq += 1;
  return {
    id: `m${seq}`,
    sessionId,
    turnId: `t${seq}`,
    role,
    content: JSON.stringify(blocks),
    createdAt: new Date(0).toISOString(),
  };
}
const text = (content: string) => [{ type: "text", content }];

describe("buildTimelineQuestions", () => {
  it("keeps main-session user messages in transcript order", () => {
    const a = msg("user", MAIN, text("first question"));
    const b = msg("assistant", MAIN, text("an answer"));
    const c = msg("user", MAIN, text("second question"));
    expect(buildTimelineQuestions([a, b, c])).toEqual([
      { messageId: a.id, text: "first question" },
      { messageId: c.id, text: "second question" },
    ]);
  });

  it("includes questions asked during a handoff", () => {
    // While a handoff is open the composer posts to the child session. Dropping
    // those would leave a whole stretch of the conversation off the rail with
    // nothing to explain the gap.
    const mine = msg("user", MAIN, text("mine"));
    const duringHandoff = msg("user", CHILD, text("asked the specialist"));
    expect(buildTimelineQuestions([mine, duringHandoff])).toEqual([
      { messageId: mine.id, text: "mine" },
      { messageId: duringHandoff.id, text: "asked the specialist" },
    ]);
  });

  it("drops user turns that render no bubble", () => {
    // UserMessage returns null for a text-less turn (an interaction_result
    // resolving an approval card), so a marker pointing at one would scroll
    // nowhere.
    const resolution = msg("user", MAIN, [
      { type: "interaction_result", toolUseId: "t-1", output: { approved: true } },
    ]);
    const blank = msg("user", MAIN, text("   "));
    expect(buildTimelineQuestions([resolution, blank])).toEqual([]);
  });
});

describe("summarizeQuestion", () => {
  it("collapses whitespace onto one line", () => {
    expect(summarizeQuestion("how do\n\n  I   ship this?")).toBe("how do I ship this?");
  });

  it("truncates past the cap", () => {
    expect(summarizeQuestion("abcdefghij", 5)).toBe("abcde…");
  });
});

describe("shouldShowTimeline", () => {
  const tall = { scrollHeight: 3000, clientHeight: 700 };

  it("shows for a long chat with enough questions", () => {
    expect(shouldShowTimeline(6, tall)).toBe(true);
  });

  it("hides below the question floor", () => {
    expect(shouldShowTimeline(3, tall)).toBe(false);
  });

  it("hides when the transcript is under two viewports tall", () => {
    expect(shouldShowTimeline(6, { scrollHeight: 900, clientHeight: 700 })).toBe(false);
  });

  it("hides before layout", () => {
    expect(shouldShowTimeline(6, { scrollHeight: 0, clientHeight: 0 })).toBe(false);
  });
});

describe("layoutTimelineNodes", () => {
  const opts = { trackHeight: 500, stepPx: 8 };

  it("places questions in a compact fixed rhythm", () => {
    expect(layoutTimelineNodes(["a", "b", "c"], opts)).toEqual([
      { messageId: "a", topPx: 242 },
      { messageId: "b", topPx: 250 },
      { messageId: "c", topPx: 258 },
    ]);
  });

  it("does not stretch a short sequence across the track", () => {
    const nodes = layoutTimelineNodes(["a", "b"], opts);
    expect(nodes.map((node) => node.topPx)).toEqual([246, 254]);
  });

  it("keeps every marker distinct up to the track's preferred capacity", () => {
    const ids = Array.from({ length: 60 }, (_, i) => `q${i}`);
    const ys = layoutTimelineNodes(ids, opts).map((node) => node.topPx);
    expect(new Set(ys).size).toBe(60);
    expect(ys[0]).toBe(14);
    expect(ys[59]).toBe(486);
  });

  it("tightens the rhythm evenly when the track overflows", () => {
    const ids = Array.from({ length: 60 }, (_, i) => `q${i}`);
    const nodes = layoutTimelineNodes(ids, { trackHeight: 400, stepPx: 8 });
    const ys = nodes.map((node) => node.topPx);
    expect(new Set(ys).size).toBe(60);
    expect(ys[0]).toBeCloseTo(0, 5);
    expect(ys[59]).toBeCloseTo(400, 5);
    expect(ys[1] - ys[0]).toBeCloseTo(400 / 59, 5);
  });

  it("returns nothing before layout", () => {
    expect(layoutTimelineNodes(["a"], { trackHeight: 0, stepPx: 8 })).toEqual([]);
    expect(layoutTimelineNodes([], opts)).toEqual([]);
  });
});

describe("sameNodes", () => {
  it("ignores sub-pixel drift", () => {
    expect(sameNodes([{ messageId: "a", topPx: 8 }], [{ messageId: "a", topPx: 8.2 }])).toBe(true);
  });

  it("notices a real move", () => {
    expect(sameNodes([{ messageId: "a", topPx: 8 }], [{ messageId: "a", topPx: 9 }])).toBe(false);
  });

  it("notices a new question", () => {
    expect(
      sameNodes(
        [{ messageId: "a", topPx: 0 }],
        [
          { messageId: "a", topPx: 0 },
          { messageId: "b", topPx: 8 },
        ],
      ),
    ).toBe(false);
  });
});
