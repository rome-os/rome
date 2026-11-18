import { describe, expect, it } from "@rstest/core";
import {
  estimateTokens,
  HANDOFF_CUT_MARKER,
  HANDOFF_RECENT_TOKENS,
  handoffSections,
  type RecentMessage,
  recentWithin,
} from "./session-handoff.js";

const message = (text: string, minute = 0): RecentMessage => ({
  senderName: "Guardian",
  text,
  at: new Date(Date.UTC(2026, 10, 12, 8, minute)),
});

describe("estimateTokens", () => {
  it("counts a token per four Latin characters and one per CJK character", () => {
    expect(estimateTokens("abcdefgh")).toBe(2);
    expect(estimateTokens("周五七点")).toBe(4);
  });
});

describe("recentWithin", () => {
  it("keeps the newest messages that fit, oldest first, and counts the rest", () => {
    const messages = Array.from({ length: 100 }, (_, index) => message("x".repeat(400), index));
    const { shown, omitted } = recentWithin(messages, 1_000);
    // Each line costs 100 tokens of text plus its time and sender.
    expect(shown.length).toBe(8);
    expect(omitted).toBe(92);
    expect(shown.at(-1)).toBe(messages.at(-1));
    expect(shown[0]).toBe(messages[92]);
  });

  it("cuts the newest message to fit when it alone is over the cap", () => {
    const { shown, omitted } = recentWithin([message("a"), message("字".repeat(50))], 20);
    expect(shown).toHaveLength(1);
    expect(shown[0]?.text).toBe(`${"字".repeat(20)}…`);
    expect(omitted).toBe(1);
  });

  it("shows more than 20 short messages, unlike the catch-up", () => {
    const messages = Array.from({ length: 60 }, (_, index) => message(`line ${index}`, index));
    expect(recentWithin(messages, HANDOFF_RECENT_TOKENS)).toEqual({ shown: messages, omitted: 0 });
  });
});

describe("recentWithin for a full handoff", () => {
  const agent = (text: string, minute = 0): RecentMessage => ({
    ...message(text, minute),
    senderName: "You",
    agent: true,
  });

  it("keeps the guardian's long messages whole", () => {
    const long = message("x".repeat(20_000));
    expect(recentWithin([long], HANDOFF_RECENT_TOKENS).shown[0]?.text).toBe(long.text);
  });

  it("cuts a long agent reply to about 1,500 tokens and marks it", () => {
    const { shown } = recentWithin([agent("x".repeat(20_000))], HANDOFF_RECENT_TOKENS);
    expect(shown[0]?.text).toBe(`${"x".repeat(6_000)}${HANDOFF_CUT_MARKER}`);
  });

  it("cuts CJK agent text at one token per character", () => {
    const { shown } = recentWithin([agent("字".repeat(5_000))], HANDOFF_RECENT_TOKENS);
    expect(shown[0]?.text).toBe(`${"字".repeat(1_500)}${HANDOFF_CUT_MARKER}`);
  });

  it("leaves a short agent reply alone", () => {
    const short = agent("x".repeat(400));
    expect(recentWithin([short], HANDOFF_RECENT_TOKENS).shown[0]).toBe(short);
  });

  it("budgets about 16,000 tokens and counts the omitted messages", () => {
    expect(HANDOFF_RECENT_TOKENS).toBe(16_000);
    const messages = Array.from({ length: 300 }, (_, index) => message("x".repeat(400), index));
    const { shown, omitted } = recentWithin(messages, HANDOFF_RECENT_TOKENS);
    // 100 tokens of text plus the line's 12 each.
    expect(shown).toHaveLength(142);
    expect(omitted).toBe(158);
    expect(shown.at(-1)).toBe(messages.at(-1));
  });

  it("spends the budget on the cut agent reply, not its full length", () => {
    const messages = [message("earlier", 0), agent("x".repeat(40_000), 1), message("now", 2)];
    const { shown, omitted } = recentWithin(messages, HANDOFF_RECENT_TOKENS);
    expect(shown).toHaveLength(3);
    expect(omitted).toBe(0);
  });
});

describe("handoffSections", () => {
  it("leaves a light handoff's messages whole, however long", () => {
    const long: RecentMessage = { ...message("x".repeat(20_000)), agent: true };
    const text = handoffSections(null, { openTasks: null, recent: [long] }, { all: true }).join(
      "\n",
    );
    expect(text).toContain("x".repeat(20_000));
    expect(text).not.toContain(HANDOFF_CUT_MARKER);
  });

  it("renders the handoff, the open tasks and the recent messages", () => {
    const text = handoffSections(" - Agreed: Friday. ", {
      openTasks: "- t-1 · Book dinner · active",
      recent: [message("Friday at 7")],
    }).join("\n");
    expect(text).toContain("<handoff>\n- Agreed: Friday.\n</handoff>");
    expect(text).toContain("<open_tasks>\n- t-1 · Book dinner · active\n</open_tasks>");
    expect(text).toContain("[2026-11-12T08:00:00.000Z] Guardian: Friday at 7");
  });

  it("leaves out the sections it has nothing for", () => {
    const text = handoffSections("note", { openTasks: null, recent: [] }).join("\n");
    expect(text).not.toContain("<open_tasks>");
    expect(text).not.toContain("<recent_messages>");
  });
});
