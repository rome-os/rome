import { describe, expect, it } from "@rstest/core";
import { REPLY_TO_TEXT_MAX_LENGTH } from "@rome/api-types/chat";
import { replyQuoteOf, textSpans, truncateQuote } from "./reply-quote.js";

const stored = (...parts: unknown[]) => JSON.stringify(parts);

describe("the quote of a reply", () => {
  it("quotes the whole text of the message, an agent's as the agent's", () => {
    expect(
      replyQuoteOf({
        id: "m1",
        role: "assistant",
        content: stored({ type: "text", content: "One." }, { type: "text", content: "Two." }),
      }),
    ).toEqual({ type: "reply_to", messageId: "m1", author: "agent", text: "One.\n\nTwo." });
  });

  it("quotes a guardian's message, and an automation's as the automation's", () => {
    const content = stored({ type: "text", content: "Weather?" });
    expect(replyQuoteOf({ id: "g1", role: "user", content })).toMatchObject({ author: "guardian" });
    expect(
      replyQuoteOf({ id: "a1", role: "user", content, senderId: "automated::0::routine:daily" }),
    ).toMatchObject({ author: "automated" });
  });

  it("reads a task card as one line, and a message with no text as nothing to quote", () => {
    expect(
      replyQuoteOf({
        id: "m2",
        role: "assistant",
        content: stored({ type: "task_chat", chatId: "c1", title: "Flights" }),
      })?.text,
    ).toBe("[Task chat] Flights (chat c1)");
    expect(replyQuoteOf({ id: "m3", role: "user", content: "[]" })).toBeNull();
    expect(textSpans("not json")).toEqual([]);
  });

  it("cuts a long quote with an ellipsis, and never inside a surrogate pair", () => {
    const long = "x".repeat(REPLY_TO_TEXT_MAX_LENGTH + 5);
    expect(truncateQuote(long)).toHaveLength(REPLY_TO_TEXT_MAX_LENGTH);
    expect(truncateQuote(long).endsWith("…")).toBe(true);
    const pair = `${"x".repeat(REPLY_TO_TEXT_MAX_LENGTH - 2)}😀tail`;
    expect(truncateQuote(pair)).toBe(`${"x".repeat(REPLY_TO_TEXT_MAX_LENGTH - 2)}…`);
  });
});
