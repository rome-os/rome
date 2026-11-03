import { describe, expect, it } from "@rstest/core";
import { numericReplyTo, refuseAttachments, refuseReplies, textToSend } from "./send-refusals.js";

const refused = (reason: string) => ({ name: "ChannelSendRefused", reason });

describe("textToSend", () => {
  it("sends the message's text, else its text parts", () => {
    expect(textToSend("telegram", { text: "Hi" })).toBe("Hi");
    expect(
      textToSend("telegram", {
        parts: [
          { type: "text", content: "One" },
          { type: "text", content: "Two" },
        ],
      }),
    ).toBe("One\n\nTwo");
    for (const blank of ["", "  "]) {
      expect(
        textToSend("telegram", { text: blank, parts: [{ type: "text", content: "Hello" }] }),
      ).toBe("Hello");
    }
  });

  it("sends an attachment with no text", () => {
    expect(textToSend("telegram", { attachments: [{ type: "image", source: "/tmp/a.png" }] })).toBe(
      "",
    );
  });

  it("refuses a part that is not text, even beside text", () => {
    expect(() =>
      textToSend("telegram", {
        text: "Recap",
        parts: [{ type: "turn_recap" } as never],
      }),
    ).toThrow(expect.objectContaining(refused("part_unsupported")));
  });

  it("refuses a message with no text and no attachment", () => {
    expect(() => textToSend("telegram", {})).toThrow(expect.objectContaining(refused("empty")));
    expect(() => textToSend("telegram", { text: "  " })).toThrow(
      expect.objectContaining(refused("empty")),
    );
  });
});

describe("refusals on what a channel cannot carry", () => {
  it("refuses attachments, and replies, where the channel has neither", () => {
    expect(() =>
      refuseAttachments("slack", { attachments: [{ type: "image", source: "/tmp/a.png" }] }),
    ).toThrow(expect.objectContaining(refused("attachment_unsupported")));
    expect(() => refuseReplies("whatsapp", { text: "x", replyToMessageId: "m1" })).toThrow(
      expect.objectContaining(refused("reply_unaddressable")),
    );
    expect(() => refuseReplies("whatsapp", { text: "x" })).not.toThrow();
  });

  it("answers a numbered reply, and refuses one that names no number", () => {
    expect(numericReplyTo("telegram", "42")).toBe(42);
    expect(numericReplyTo("telegram", undefined)).toBeUndefined();
    expect(() => numericReplyTo("telegram", "rome:abc")).toThrow(
      expect.objectContaining(refused("reply_unaddressable")),
    );
  });
});
