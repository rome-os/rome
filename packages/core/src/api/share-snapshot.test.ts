import { describe, expect, it } from "@rstest/core";
import { NEUTRAL_SHARE_TITLE, shareTitleOf, type ChatShareMessage } from "./share-snapshot.js";

const message = (id: string, turnId: string, role: string, content: string): ChatShareMessage => ({
  id,
  sessionId: "s",
  turnId,
  role,
  content,
  createdAt: "2026-11-10T00:00:00.000Z",
});
const parts = (text: string) => JSON.stringify([{ type: "text", content: text }]);

describe("shareTitleOf", () => {
  it("takes the first line of the first turn's own message, as plain text", () => {
    expect(
      shareTitleOf([
        message("u1", "t1", "user", parts("## Plan **my** [trip](https://x.test)\nfor two")),
        message("a1", "t1", "assistant", parts("Day one")),
        message("u2", "t2", "user", parts("Later question")),
      ]),
    ).toBe("Plan my trip");
  });

  it("reads a message stored as plain text", () => {
    expect(shareTitleOf([message("u1", "t1", "user", "  - Book a hotel  ")])).toBe("Book a hotel");
  });

  it("falls back to the turn's first reply, then to a neutral title", () => {
    expect(
      shareTitleOf([
        message("u1", "t1", "user", JSON.stringify([{ type: "reply_to", messageId: "x" }])),
        message("a1", "t1", "assistant", parts("\n\n> Lisbon in three days")),
      ]),
    ).toBe("Lisbon in three days");
    expect(shareTitleOf([message("u1", "t1", "user", "   ")])).toBe(NEUTRAL_SHARE_TITLE);
    expect(shareTitleOf([])).toBe(NEUTRAL_SHARE_TITLE);
  });

  it("cuts a long line short", () => {
    const title = shareTitleOf([message("u1", "t1", "user", "word ".repeat(60))]);
    expect(title.length).toBeLessThanOrEqual(100);
    expect(title.endsWith("…")).toBe(true);
  });
});
