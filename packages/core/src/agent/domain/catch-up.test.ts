import { describe, expect, it } from "@rstest/core";
import { catchUpPrompt } from "./catch-up.js";
import type { PromptMessage, UnseenMessage } from "./prompt-facts.js";

const at = new Date("2026-11-07T10:00:00.000Z");

function said(id: number, text: string, more: Partial<UnseenMessage> = {}): UnseenMessage {
  return {
    id,
    senderName: "Ada",
    text,
    at,
    fromRome: false,
    quoted: null,
    quotesOutside: false,
    ...more,
  };
}

describe("catchUpPrompt", () => {
  it("leaves the prompt unchanged with nothing to catch up on", () => {
    expect(catchUpPrompt("hi", { unseen: [] })).toBe("hi");
  });

  it("shows the last 20 unseen messages and counts the rest", () => {
    const unseen = Array.from({ length: 22 }, (_, i) => said(i + 1, `m${i + 1}`));
    const lines = catchUpPrompt("hi", { unseen }).split("\n");
    expect(lines[0]).toBe("<conversation_context>");
    expect(lines[1]).toBe("[2 earlier messages omitted]");
    expect(lines[2]).toBe(`[${at.toISOString()}] Ada: m3`);
    expect(lines.slice(-4)).toEqual([
      "</conversation_context>",
      "<current_message>",
      "hi",
      "</current_message>",
    ]);
  });

  it("puts the message that started the thread first", () => {
    const starter: PromptMessage = { id: 9, senderName: "Bo", text: "start", at };
    const prompt = catchUpPrompt("hi", {
      unseen: [
        said(1, "a"),
        said(2, "rome", { fromRome: true, quotesOutside: true, quoted: starter }),
      ],
    });
    expect(prompt.split("\n").slice(1, 4)).toEqual([
      `[${at.toISOString()}] Bo: start`,
      `[${at.toISOString()}] Ada: a`,
      `[${at.toISOString()}] Ada: rome`,
    ]);
  });

  it("moves the message replied to out of the unseen ones into the reply context", () => {
    const prompt = catchUpPrompt("hi", {
      unseen: [said(1, "a"), said(2, "b")],
      quoted: { id: 2, senderName: null, text: "b", at },
    });
    expect(prompt).toBe(
      [
        "<conversation_context>",
        `[${at.toISOString()}] Ada: a`,
        "</conversation_context>",
        "<reply_context>",
        `[${at.toISOString()}] Unknown sender: b`,
        "</reply_context>",
        "<current_message>",
        "hi",
        "</current_message>",
      ].join("\n"),
    );
  });

  it("falls back to the platform's copy of the message replied to", () => {
    const prompt = catchUpPrompt("hi", {
      unseen: [],
      replyTo: { messageId: "p1", senderName: "Cy", content: "earlier" },
    });
    expect(prompt).toBe(
      [
        "<reply_context>",
        "Cy: earlier",
        "</reply_context>",
        "<current_message>",
        "hi",
        "</current_message>",
      ].join("\n"),
    );
  });
});
