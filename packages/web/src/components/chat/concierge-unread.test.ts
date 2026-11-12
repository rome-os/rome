import { describe, expect, it } from "@rstest/core";
import type { ChatMessage } from "@/lib/chat-types";
import { firstUnreadMessageId } from "./concierge-unread";

function message(id: string, role: ChatMessage["role"]): ChatMessage {
  return {
    id,
    sessionId: "concierge",
    role,
    content: "[]",
    createdAt: "2026-10-27T12:00:00.000Z",
  };
}

const agent = (id: string) => message(id, "assistant");
const guardian = (id: string) => message(id, "user");

describe("firstUnreadMessageId", () => {
  const messages = [agent("a1"), guardian("g1"), agent("a2"), agent("a3"), guardian("g2")];

  it("names the count-th agent message from the end", () => {
    expect(firstUnreadMessageId(messages, { count: 1, newestId: "g2" })).toBe("a3");
    expect(firstUnreadMessageId(messages, { count: 2, newestId: "g2" })).toBe("a2");
    expect(firstUnreadMessageId(messages, { count: 3, newestId: "g2" })).toBe("a1");
  });

  it("leaves the guardian's own messages out of the count", () => {
    expect(firstUnreadMessageId([agent("a1"), guardian("g1")], { count: 1, newestId: "g1" })).toBe(
      "a1",
    );
  });

  it("returns null when nothing was unread", () => {
    expect(firstUnreadMessageId(messages, { count: 0, newestId: "g2" })).toBeNull();
  });

  it("returns null while the first unread message is on an older page", () => {
    expect(firstUnreadMessageId(messages, { count: 4, newestId: "g2" })).toBeNull();
  });

  it("finds it once the older page has loaded", () => {
    const older = [agent("a0"), ...messages];
    expect(firstUnreadMessageId(older, { count: 4, newestId: "g2" })).toBe("a0");
  });

  it("ignores messages that arrived after the chat opened", () => {
    const later = [...messages, agent("a4"), agent("a5")];
    expect(firstUnreadMessageId(later, { count: 2, newestId: "g2" })).toBe("a2");
  });

  it("falls back to the whole transcript when the newest message at open is gone", () => {
    expect(firstUnreadMessageId(messages, { count: 1, newestId: "gone" })).toBe("a3");
  });

  it("skips trace and notification messages", () => {
    const mixed = [agent("a1"), message("tr", "trace"), message("n1", "notification"), agent("a2")];
    expect(firstUnreadMessageId(mixed, { count: 2, newestId: "a2" })).toBe("a1");
  });
});
