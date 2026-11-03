import { describe, expect, it } from "@rstest/core";
import {
  currentMessageSection,
  replyContextLine,
  replyContextSection,
  withReplyContext,
} from "./reply-context.js";

describe("reply context", () => {
  it("formats a line with its timestamp and sender", () => {
    expect(
      replyContextLine({
        createdAt: new Date("2026-10-27T08:00:00.000Z"),
        sender: "Ray",
        text: "see you at 5",
      }),
    ).toBe("[2026-10-27T08:00:00.000Z] Ray: see you at 5");
  });

  it("leaves the timestamp out when the message has none", () => {
    expect(replyContextLine({ sender: "Ray", text: "hi" })).toBe("Ray: hi");
  });

  it("wraps the line and the prompt in their blocks", () => {
    expect(replyContextSection("Ray: hi")).toEqual([
      "<reply_context>",
      "Ray: hi",
      "</reply_context>",
    ]);
    expect(currentMessageSection("ok")).toEqual(["<current_message>", "ok", "</current_message>"]);
    expect(withReplyContext("ok", "Ray: hi")).toBe(
      "<reply_context>\nRay: hi\n</reply_context>\n<current_message>\nok\n</current_message>",
    );
  });
});
