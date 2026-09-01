import { describe, expect, it } from "@rstest/core";
import type { ChatMessage } from "@/lib/chat-types";
import {
  buildTimelineQuestions,
  layoutTimelineNodes,
  sameNodes,
  shouldShowTimeline,
  summarizeQuestion,
  type MeasuredAnchor,
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
    // resolving an approval card), so a dot pointing at one would scroll
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
  const opts = { contentHeight: 1000, trackHeight: 500, minGapPx: 8 };

  it("places each dot at its share of the content height", () => {
    const anchors: MeasuredAnchor[] = [
      { messageId: "a", top: 0 },
      { messageId: "b", top: 500 },
    ];
    expect(layoutTimelineNodes(anchors, opts)).toEqual([
      { messageId: "a", fraction: 0 },
      { messageId: "b", fraction: 0.5 },
    ]);
  });

  it("pushes a crowded dot down instead of dropping it", () => {
    // b is 4px below a on a 500px track — under the 8px floor. It moves to 8px
    // (fraction 0.016) and stays clickable. This is the whole point: merging
    // would make b unreachable while looking identical to a lossless dot.
    const anchors: MeasuredAnchor[] = [
      { messageId: "a", top: 0 },
      { messageId: "b", top: 8 },
    ];
    const nodes = layoutTimelineNodes(anchors, opts);
    expect(nodes).toHaveLength(2);
    expect(nodes[0].fraction).toBe(0);
    expect(nodes[1].fraction).toBeCloseTo(0.016, 5);
  });

  it("keeps pushing across a dense run", () => {
    const anchors: MeasuredAnchor[] = [
      { messageId: "a", top: 0 },
      { messageId: "b", top: 2 },
      { messageId: "c", top: 4 },
    ];
    const nodes = layoutTimelineNodes(anchors, opts);
    expect(nodes.map((n) => Math.round(n.fraction * 500))).toEqual([0, 8, 16]);
  });

  it("ends the last dot at the foot of the track", () => {
    const anchors: MeasuredAnchor[] = [
      { messageId: "a", top: 1000 },
      { messageId: "b", top: 1000 },
    ];
    const nodes = layoutTimelineNodes(anchors, opts);
    expect(nodes.map((n) => Math.round(n.fraction * 500))).toEqual([492, 500]);
  });

  it("pulls a dense run at the bottom back up instead of stacking it", () => {
    // Three questions in the last 1% of the transcript. A forward-only pass
    // clamps the last two onto the same pixel, so one of them can never be
    // clicked — while the track still has 484px of unused room above.
    const anchors: MeasuredAnchor[] = [
      { messageId: "a", top: 990 },
      { messageId: "b", top: 995 },
      { messageId: "c", top: 1000 },
    ];
    const nodes = layoutTimelineNodes(anchors, opts);
    expect(nodes.map((n) => Math.round(n.fraction * 500))).toEqual([484, 492, 500]);
  });

  it("keeps every dot distinct up to the track's real capacity", () => {
    // 60 questions all at the very bottom; a 500px track at an 8px gap holds
    // 63, so none of them may share a position.
    const anchors: MeasuredAnchor[] = Array.from({ length: 60 }, (_, i) => ({
      messageId: `q${i}`,
      top: 1000,
    }));
    const ys = layoutTimelineNodes(anchors, opts).map((n) => n.fraction * 500);
    expect(new Set(ys.map((y) => Math.round(y))).size).toBe(60);
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...ys)).toBeCloseTo(500, 5);
  });

  it("tightens the gap rather than stacking once the track overflows", () => {
    // 60 questions on a 400px track: at an 8px gap only 51 fit, so a fixed gap
    // would clamp the surplus onto y=0 and make all but one unreachable.
    const anchors: MeasuredAnchor[] = Array.from({ length: 60 }, (_, i) => ({
      messageId: `q${i}`,
      top: 1000,
    }));
    const nodes = layoutTimelineNodes(anchors, {
      contentHeight: 1000,
      trackHeight: 400,
      minGapPx: 8,
    });
    const ys = nodes.map((n) => n.fraction * 400);
    expect(new Set(ys).size).toBe(60);
    expect(ys[0]).toBeCloseTo(0, 5);
    expect(ys[59]).toBeCloseTo(400, 5);
    // Evenly spread across the track at the tightened gap.
    expect(ys[1] - ys[0]).toBeCloseTo(400 / 59, 5);
  });

  it("returns nothing before layout", () => {
    expect(
      layoutTimelineNodes([{ messageId: "a", top: 0 }], {
        contentHeight: 0,
        trackHeight: 500,
        minGapPx: 8,
      }),
    ).toEqual([]);
  });
});

describe("sameNodes", () => {
  it("ignores sub-pixel drift", () => {
    expect(
      sameNodes([{ messageId: "a", fraction: 0.5 }], [{ messageId: "a", fraction: 0.5005 }]),
    ).toBe(true);
  });

  it("notices a real move", () => {
    expect(
      sameNodes([{ messageId: "a", fraction: 0.5 }], [{ messageId: "a", fraction: 0.6 }]),
    ).toBe(false);
  });

  it("notices a new question", () => {
    expect(
      sameNodes(
        [{ messageId: "a", fraction: 0 }],
        [
          { messageId: "a", fraction: 0 },
          { messageId: "b", fraction: 1 },
        ],
      ),
    ).toBe(false);
  });
});
