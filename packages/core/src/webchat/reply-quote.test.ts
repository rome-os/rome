import { describe, expect, it } from "@rstest/core";
import { REPLY_TO_TEXT_MAX_LENGTH } from "@rome/api-types/chat";
import {
  quoteSpans,
  replyQuoteOf,
  storedQuoteLine,
  textSpans,
  truncateQuote,
} from "./reply-quote.js";

const stored = (...parts: unknown[]) => JSON.stringify(parts);

describe("the quote of a reply", () => {
  it("quotes the whole text of the message, an agent's as the agent's", async () => {
    expect(
      await replyQuoteOf({
        id: "m1",
        role: "assistant",
        content: stored({ type: "text", content: "One." }, { type: "text", content: "Two." }),
      }),
    ).toEqual({ type: "reply_to", messageId: "m1", author: "agent", text: "One.\n\nTwo." });
  });

  it("quotes a guardian's message, and an automation's as the automation's", async () => {
    const content = stored({ type: "text", content: "Weather?" });
    expect(await replyQuoteOf({ id: "g1", role: "user", content })).toMatchObject({
      author: "guardian",
    });
    expect(
      await replyQuoteOf({
        id: "a1",
        role: "user",
        content,
        senderId: "automated::0::routine:daily",
      }),
    ).toMatchObject({ author: "automated" });
  });

  it("reads a task card as its own words, never an id", async () => {
    const card = (extra: object = {}) =>
      stored({ type: "task_chat", chatId: "c1", title: "Flights", ...extra });
    const quoted = (content: string, line?: () => Promise<string | null>) =>
      replyQuoteOf({ id: "m2", role: "assistant", content }, line)?.then((quote) => quote?.text);
    // A task card is its task's title.
    expect(await quoted(card({ show: "task" }))).toBe("Flights");
    // An ask card is its question or approval, else the title.
    const waitedOn = { kind: "approval", id: "a1" };
    expect(await quoted(card({ show: "ask", waitedOn }), async () => "Send it?")).toBe("Send it?");
    expect(await quoted(card({ show: "ask", waitedOn }), async () => null)).toBe("Flights");
    expect(await quoted(card({ show: "ask" }))).toBe("Flights");
    // A forward quotes what it forwarded.
    expect(
      await quoted(
        stored({
          type: "text",
          content: "Booked.",
          forwardedFrom: { chatId: "c1", title: "Flights" },
        }),
      ),
    ).toBe("Booked.");
  });

  it("keeps the chat's id in the agent's reading of a card only", async () => {
    const content = stored({ type: "task_chat", chatId: "c1", title: "Flights" });
    expect(textSpans(content).map((span) => span.text)).toEqual(["[Task chat] Flights (chat c1)"]);
    expect((await quoteSpans(content)).map((span) => span.text)).toEqual(["Flights"]);
  });

  it("has nothing to quote in a message with no text", async () => {
    expect(await replyQuoteOf({ id: "m3", role: "user", content: "[]" })).toBeNull();
    expect(textSpans("not json")).toEqual([]);
  });

  it("cuts a long quote with an ellipsis, and never inside a surrogate pair", () => {
    const long = "x".repeat(REPLY_TO_TEXT_MAX_LENGTH + 5);
    expect(truncateQuote(long)).toHaveLength(REPLY_TO_TEXT_MAX_LENGTH);
    expect(truncateQuote(long).endsWith("…")).toBe(true);
    const pair = `${"x".repeat(REPLY_TO_TEXT_MAX_LENGTH - 2)}😀tail`;
    expect(truncateQuote(pair)).toBe(`${"x".repeat(REPLY_TO_TEXT_MAX_LENGTH - 2)}…`);
  });

  it("names a thread by the first line with text of the quote a reply carries", () => {
    const quote = { type: "reply_to", messageId: "m1", author: "guardian" };
    expect(
      storedQuoteLine(
        stored({ type: "text", content: "Yes" }, { ...quote, text: "\n Plan\nmore" }),
      ),
    ).toBe("Plan");
    expect(storedQuoteLine(stored({ type: "text", content: "Yes" }))).toBeNull();
    expect(storedQuoteLine("not json")).toBeNull();
  });
});
