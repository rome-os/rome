import { describe, expect, it } from "@rstest/core";
import {
  estimateTokens,
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

describe("handoffSections", () => {
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
