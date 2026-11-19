import { describe, expect, it } from "@rstest/core";
import type { ChatMessage } from "./chat-types";
import {
  mergeChatMessage,
  mergeLatestMessagePage,
  prependChatMessages,
  startsNewHistory,
} from "./chat-message-merge";

// Times are on the messages only so the tests can show they decide nothing: the
// order is the one the server sent.
function message(
  id: string,
  createdAt = "2026-01-01T00:00:00.000Z",
  role: ChatMessage["role"] = "assistant",
  content = "[]",
): ChatMessage {
  return { id, sessionId: "session-1", turnId: null, role, content, createdAt };
}
const ids = (messages: ChatMessage[]) => messages.map((item) => item.id);

describe("a live message", () => {
  it("goes last, in the order it arrived, whatever time it carries", () => {
    const held = [
      message("a", "2026-01-01T00:00:05.000Z"),
      message("b", "2026-01-01T00:00:06.000Z"),
    ];

    const merged = mergeChatMessage(held, message("c", "2026-01-01T00:00:01.000Z"));

    expect(ids(merged)).toEqual(["a", "b", "c"]);
  });

  it("replaces the held message with its id where it stands", () => {
    const held = [message("a"), message("b"), message("c")];
    const edited = message("b", "2026-01-01T09:00:00.000Z", "assistant", "[1]");

    const merged = mergeChatMessage(held, edited);

    expect(ids(merged)).toEqual(["a", "b", "c"]);
    expect(merged[1]).toBe(edited);
    expect(merged[0]).toBe(held[0]);
  });

  it("replaces an optimistic row with the accepted one where the optimistic one stands", () => {
    const held = [message("a"), message("local-user", undefined, "user"), message("c")];

    const merged = mergeChatMessage(held, message("db-user", undefined, "user"), "local-user");

    expect(ids(merged)).toEqual(["a", "db-user", "c"]);
  });

  it("goes last when the row it replaces is not held", () => {
    expect(ids(mergeChatMessage([message("a")], message("db-user"), "gone"))).toEqual([
      "a",
      "db-user",
    ]);
  });
});

describe("an older page", () => {
  it("goes above the held messages, as it came", () => {
    const merged = prependChatMessages([message("c"), message("d")], [message("a"), message("b")]);

    expect(ids(merged)).toEqual(["a", "b", "c", "d"]);
  });

  it("takes the place of a held message it carries again, such as the trace of a turn on both pages", () => {
    const newer = [
      message("answer-a"),
      message("trace-a", undefined, "trace"),
      message("answer-b"),
    ];
    const older = [message("owner-a"), message("owner-b"), message("trace-a", undefined, "trace")];

    expect(ids(prependChatMessages(newer, older))).toEqual([
      "owner-a",
      "owner-b",
      "trace-a",
      "answer-a",
      "answer-b",
    ]);
  });
});

describe("refetching the newest page of a paged chat", () => {
  const older = [message("o1"), message("o2")];
  const newest = [message("n1"), message("n2")];

  it("replaces the held messages from the page's first onward, and keeps the older pages", () => {
    const refetched = [message("n1"), message("n2"), message("n3")];

    const merged = mergeLatestMessagePage([...older, ...newest], refetched);

    expect(ids(merged)).toEqual(["o1", "o2", "n1", "n2", "n3"]);
  });

  it("keeps a message the page left out after it, such as a live one the server read too early", () => {
    const live = message("live");

    const merged = mergeLatestMessagePage([...older, ...newest, live], newest);

    expect(ids(merged)).toEqual(["o1", "o2", "n1", "n2", "live"]);
  });

  it("drops the optimistic rows the page stands in for", () => {
    const optimistic = message("local-user", undefined, "user");

    const merged = mergeLatestMessagePage([...older, ...newest, optimistic], newest, {
      dropMessageIds: new Set([optimistic.id]),
    });

    expect(ids(merged)).toEqual(["o1", "o2", "n1", "n2"]);
  });

  it("places the page by its first message, not by a trace that comes with it", () => {
    // The trace of turn x is held in the older page, which it also belongs to.
    const held = [
      message("o1"),
      message("trace-x", undefined, "trace"),
      message("o2"),
      message("n1"),
    ];
    const page = [message("n1"), message("trace-x", undefined, "trace"), message("n2")];

    const merged = mergeLatestMessagePage(held, page);

    expect(ids(merged)).toEqual(["o1", "o2", "n1", "trace-x", "n2"]);
  });

  it("does not start over when the page overlaps what is held", () => {
    expect(startsNewHistory([...older, ...newest], { messages: newest, hasOlder: true })).toBe(
      false,
    );
  });

  it("does not start over when nothing is held yet", () => {
    expect(startsNewHistory([], { messages: newest, hasOlder: true })).toBe(false);
  });

  it("does not start over when the page reaches the start of the chat", () => {
    expect(startsNewHistory(older, { messages: newest, hasOlder: false })).toBe(false);
  });

  it("starts over when messages between the held history and the page were never fetched", () => {
    expect(startsNewHistory(older, { messages: newest, hasOlder: true })).toBe(true);

    const merged = mergeLatestMessagePage(older, newest, { restart: true });

    expect(ids(merged)).toEqual(["n1", "n2"]);
  });

  it("does not take a trace held in both for the page reaching the held history", () => {
    const trace = message("trace-x", undefined, "trace");

    expect(
      startsNewHistory([...older, trace], { messages: [...newest, trace], hasOlder: true }),
    ).toBe(true);
  });

  it("keeps the rows named to keep after the page when it starts over", () => {
    const optimistic = message("local-user", undefined, "user");

    const merged = mergeLatestMessagePage([...older, optimistic], newest, {
      restart: true,
      keepMessageIds: new Set([optimistic.id]),
    });

    expect(ids(merged)).toEqual(["n1", "n2", "local-user"]);
  });
});
