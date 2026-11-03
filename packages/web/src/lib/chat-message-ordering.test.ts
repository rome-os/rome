import { describe, expect, it } from "@rstest/core";
import type { ChatMessage } from "./chat-types";
import {
  mergeFetchedChatMessages,
  mergeLatestMessagePage,
  orderChatMessages,
  startsNewHistory,
} from "./chat-message-ordering";

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

describe("refetching the newest page of a paged chat", () => {
  const older = [
    message("o-user", "turn-o", "2026-01-01T00:00:00.000Z", "user"),
    message("o-assistant", "turn-o", "2026-01-01T00:00:01.000Z"),
  ];
  const newest = [
    message("n-user", "turn-n", "2026-01-01T01:00:00.000Z", "user"),
    message("n-assistant", "turn-n", "2026-01-01T01:00:01.000Z"),
  ];

  it("keeps the older pages already loaded", () => {
    const refetched = [...newest, message("n-recap", "turn-n", "2026-01-01T01:00:02.000Z")];

    const merged = mergeLatestMessagePage([...older, ...newest], refetched);

    expect(merged.map((item) => item.id)).toEqual([
      "o-user",
      "o-assistant",
      "n-user",
      "n-assistant",
      "n-recap",
    ]);
  });

  it("does not start over when the page overlaps what is loaded", () => {
    expect(startsNewHistory([...older, ...newest], { messages: newest, hasOlder: true })).toBe(
      false,
    );
  });

  it("does not start over when nothing is loaded yet", () => {
    expect(startsNewHistory([], { messages: newest, hasOlder: true })).toBe(false);
  });

  it("does not start over when the page reaches the start of the chat", () => {
    expect(startsNewHistory(older, { messages: newest, hasOlder: false })).toBe(false);
  });

  it("starts over when turns between the loaded history and the page were never fetched", () => {
    expect(startsNewHistory(older, { messages: newest, hasOlder: true })).toBe(true);

    const merged = mergeLatestMessagePage(older, newest, { restart: true });

    expect(merged.map((item) => item.id)).toEqual(["n-user", "n-assistant"]);
  });

  it("keeps a local message newer than the page when it starts over", () => {
    const optimistic = message("local-user", null, "2026-01-01T02:00:00.000Z", "user");

    const merged = mergeLatestMessagePage([...older, optimistic], newest, { restart: true });

    expect(merged.map((item) => item.id)).toEqual(["n-user", "n-assistant", "local-user"]);
  });
});
