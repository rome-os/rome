import { describe, expect, it } from "@rstest/core";
import type { ChatMessage } from "./chat-types";
import { mergeFetchedChatMessages, orderChatMessages } from "./chat-message-ordering";

function message(
  id: string,
  turnId: string | null,
  createdAt: string,
  role: ChatMessage["role"] = "assistant",
): ChatMessage {
  return {
    id,
    sessionId: "session-1",
    turnId,
    role,
    content: "[]",
    createdAt,
  };
}

describe("chat message ordering", () => {
  it("keeps late turn inserts grouped with their original turn", () => {
    const ordered = orderChatMessages([
      message("a-user", "turn-a", "2026-01-01T00:00:00.000Z", "user"),
      message("a-assistant", "turn-a", "2026-01-01T00:00:01.000Z"),
      message("b-user", "turn-b", "2026-01-01T00:00:02.000Z", "user"),
      message("b-assistant", "turn-b", "2026-01-01T00:00:03.000Z"),
      message("a-recap", "turn-a", "2026-01-01T00:00:04.000Z"),
    ]);

    expect(ordered.map((item) => item.id)).toEqual([
      "a-user",
      "a-assistant",
      "a-recap",
      "b-user",
      "b-assistant",
    ]);
  });

  it("merges fetched messages without clobbering a live insert that arrived later", () => {
    const fetched = [
      message("a-user", "turn-a", "2026-01-01T00:00:00.000Z", "user"),
      message("a-assistant", "turn-a", "2026-01-01T00:00:01.000Z"),
    ];
    const liveRecap = message("a-recap", "turn-a", "2026-01-01T00:00:02.000Z");
    const merged = mergeFetchedChatMessages([...fetched, liveRecap], fetched);

    expect(merged.map((item) => item.id)).toEqual(["a-user", "a-assistant", "a-recap"]);
  });

  it("drops local optimistic placeholders when an authoritative refresh asks for it", () => {
    const optimistic = message("local-user", null, "2026-01-01T00:00:00.000Z", "user");
    const persisted = message("db-user", "turn-a", "2026-01-01T00:00:00.000Z", "user");
    const merged = mergeFetchedChatMessages([optimistic], [persisted], {
      dropMessageIds: new Set([optimistic.id]),
    });

    expect(merged.map((item) => item.id)).toEqual(["db-user"]);
  });
});
