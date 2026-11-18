import { describe, expect, it } from "@rstest/core";
import type { ChatMessage } from "./chat-types";
import {
  mergeFetchedChatMessages,
  mergeLatestMessagePage,
  orderChatMessages,
  replaceLoadedMessages,
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

describe("replacing the loaded transcript with a page that read all of it", () => {
  const at = (minute: number) => `2026-01-01T00:0${minute}:00.000Z`;

  it("drops a loaded message the page does not hold, and keeps a row still on its way", () => {
    const current = [
      message("kept", null, at(1), "user"),
      message("deleted", null, at(2), "user"),
      message("sending", null, at(3), "user"),
      message("newer", null, at(9), "user"),
    ];
    const fetched = [message("kept", null, at(1), "user"), message("added", null, at(4), "user")];

    const next = replaceLoadedMessages(current, fetched, { keepIds: new Set(["sending"]) });

    // `newer` is later than anything the page holds, so it cannot be a deletion.
    expect(next.map((item) => item.id)).toEqual(["kept", "sending", "added", "newer"]);
  });

  it("changes nothing for an empty page but the messages it is told to drop", () => {
    const current = [message("a", null, at(1)), message("b", null, at(2))];
    expect(
      replaceLoadedMessages(current, [], { dropMessageIds: new Set(["b"]) }).map((item) => item.id),
    ).toEqual(["a"]);
  });
});

describe("restarting from a named time", () => {
  it("drops the history older than `since`, not older than the oldest message the page holds", () => {
    const current = [
      message("old", null, "2026-01-01T00:01:00.000Z", "user"),
      message("main", null, "2026-01-01T00:05:00.000Z", "user"),
    ];
    // A waiting reply older than everything loaded rides on the page.
    const fetched = [
      message("waiting", null, "2026-01-01T00:00:00.000Z"),
      message("fresh", null, "2026-01-01T00:09:00.000Z", "user"),
    ];
    const since = Date.parse("2026-01-01T00:09:00.000Z");

    expect(
      mergeLatestMessagePage(current, fetched, { restart: true, since }).map((item) => item.id),
    ).toEqual(["waiting", "fresh"]);
    expect(
      mergeLatestMessagePage(current, fetched, { restart: true }).map((item) => item.id),
    ).toEqual(["waiting", "old", "main", "fresh"]);
  });
});
