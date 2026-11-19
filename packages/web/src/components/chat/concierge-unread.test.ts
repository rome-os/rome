// @rstest-environment jsdom
import { describe, expect, it } from "@rstest/core";
import { act, renderHook } from "@testing-library/react";
import {
  mergeChatMessage,
  mergeFetchedChatMessages,
  orderChatMessages,
} from "@/lib/chat-message-ordering";
import type { ChatMessage } from "@/lib/chat-types";
import { summarizeUnread, type UnreadAtOpen, useUnreadAtOpen } from "./concierge-unread";

const MARK = "2026-10-27T12:10:00.000Z";
const text = (content: string) => JSON.stringify([{ type: "text", content }]);

function message(
  id: string,
  role: ChatMessage["role"],
  createdAt: string,
  extra: { content?: string; turnId?: string } = {},
): ChatMessage {
  return {
    id,
    sessionId: "concierge",
    role,
    createdAt,
    content: extra.content ?? text(id),
    ...extra,
  };
}

const agent = (id: string, createdAt: string, extra?: { content?: string; turnId?: string }) =>
  message(id, "assistant", createdAt, extra);
const guardian = (id: string, createdAt: string, turnId?: string) =>
  message(id, "user", createdAt, { turnId });

/** The state a chat holds when it opens on `page`, with the read mark at `mark`. */
function opened(page: ChatMessage[], mark = MARK): { messages: ChatMessage[]; open: UnreadAtOpen } {
  const messages = orderChatMessages(page);
  const said = messages.filter((m) => m.role !== "trace");
  return {
    messages,
    open: {
      watermark: mark,
      openedThrough: Math.max(...said.map((m) => Math.floor(Date.parse(m.createdAt) / 1000))),
    },
  };
}

// a1 and a2 were read, a3 and a4 were not.
const history = () => [
  agent("a1", "2026-10-27T12:00:00.000Z"),
  guardian("g1", "2026-10-27T12:05:00.000Z"),
  agent("a2", "2026-10-27T12:10:00.000Z"),
  agent("a3", "2026-10-27T12:11:00.000Z"),
  guardian("g2", "2026-10-27T12:12:00.000Z"),
  agent("a4", "2026-10-27T12:13:00.000Z"),
];

describe("summarizeUnread", () => {
  it("names the first agent message created after the read mark and counts those after it", () => {
    const { messages, open } = opened(history());
    expect(summarizeUnread(messages, open, false)).toEqual({
      firstId: "a3",
      count: 2,
      more: false,
    });
  });

  it("counts a message in the same second as the read mark as read, as the server does", () => {
    const { messages, open } = opened([
      agent("a1", "2026-10-27T12:10:00.900Z"),
      agent("a2", "2026-10-27T12:10:01.000Z"),
    ]);
    expect(summarizeUnread(messages, open, false)).toEqual({
      firstId: "a2",
      count: 1,
      more: false,
    });
  });

  it("leaves the guardian's own messages out", () => {
    const { messages, open } = opened([
      agent("a1", "2026-10-27T12:00:00.000Z"),
      guardian("g1", "2026-10-27T12:20:00.000Z"),
    ]);
    expect(summarizeUnread(messages, open, false)).toBeNull();
  });

  it("returns null when nothing is unread", () => {
    const { messages, open } = opened(history(), "2026-10-27T12:13:00.000Z");
    expect(summarizeUnread(messages, open, false)).toBeNull();
  });

  it("returns null for a read mark it cannot read", () => {
    const { messages, open } = opened(history(), "yesterday");
    expect(summarizeUnread(messages, open, false)).toBeNull();
  });

  it("counts only the unread messages the chat draws", () => {
    const { messages, open } = opened([
      agent("a1", "2026-10-27T12:00:00.000Z"),
      agent("a2", "2026-10-27T12:11:00.000Z", { content: text(" ") }),
      agent("a3", "2026-10-27T12:12:00.000Z"),
      agent("a4", "2026-10-27T12:13:00.000Z"),
    ]);
    expect(summarizeUnread(messages, open, false)).toEqual({
      firstId: "a3",
      count: 2,
      more: false,
    });
  });

  it("does not count a model-switch notice as a message", () => {
    const notice = JSON.stringify([{ type: "quota_switch", from: "a", to: "b", model: "m" }]);
    const { messages, open } = opened([
      agent("a1", "2026-10-27T12:00:00.000Z"),
      agent("a2", "2026-10-27T12:11:00.000Z", { content: notice }),
      agent("a3", "2026-10-27T12:12:00.000Z"),
    ]);
    expect(summarizeUnread(messages, open, false)).toEqual({
      firstId: "a3",
      count: 1,
      more: false,
    });
  });

  it("returns null when every unread message draws nothing", () => {
    const { messages, open } = opened([
      agent("a1", "2026-10-27T12:00:00.000Z"),
      agent("a2", "2026-10-27T12:11:00.000Z", { content: text(" ") }),
    ]);
    expect(summarizeUnread(messages, open, false)).toBeNull();
  });

  it("judges each message by when it was said, whichever turn it belongs to", () => {
    // Turn A's reply came after the mark, B's before it, though B's prompt was said after A's.
    const { messages, open } = opened([
      guardian("uA", "2026-10-27T12:00:00.000Z", "turn-a"),
      guardian("uB", "2026-10-27T12:05:00.000Z", "turn-b"),
      agent("aB", "2026-10-27T12:06:00.000Z", { turnId: "turn-b" }),
      agent("aA", "2026-10-27T12:12:00.000Z", { turnId: "turn-a" }),
    ]);
    expect(messages.map((m) => m.id)).toEqual(["uA", "uB", "aB", "aA"]);
    expect(summarizeUnread(messages, open, false)).toEqual({
      firstId: "aA",
      count: 1,
      more: false,
    });
  });

  describe("with older pages", () => {
    const ids = (messages: ChatMessage[]) => messages.map((m) => m.id);

    it("keeps looking while the oldest loaded message is unread, and names the first once no page remains", () => {
      const { messages, open } = opened([
        agent("a3", "2026-10-27T12:11:00.000Z"),
        guardian("g2", "2026-10-27T12:12:00.000Z"),
        agent("a4", "2026-10-27T12:13:00.000Z"),
      ]);
      expect(summarizeUnread(messages, open, true)).toEqual({
        firstId: null,
        count: 2,
        more: true,
      });
      const loaded = mergeFetchedChatMessages(messages, [
        agent("a1", "2026-10-27T12:00:00.000Z"),
        agent("a2", "2026-10-27T12:10:30.000Z"),
      ]);
      expect(ids(loaded)).toEqual(["a1", "a2", "a3", "g2", "a4"]);
      expect(summarizeUnread(loaded, open, false)).toEqual({
        firstId: "a2",
        count: 3,
        more: false,
      });
    });

    it("has the first message when the oldest loaded one is at or before the mark", () => {
      const { messages, open } = opened(history());
      expect(summarizeUnread(messages, open, true)).toEqual({
        firstId: "a3",
        count: 2,
        more: false,
      });
    });

    it("looks past a trace that comes with its turn and is older than every message loaded", () => {
      const { messages, open } = opened([
        message("trace-a", "trace", "2026-10-27T12:00:00.000Z", { turnId: "turn-a" }),
        agent("a3", "2026-10-27T12:11:00.000Z", { turnId: "turn-a" }),
        agent("a4", "2026-10-27T12:13:00.000Z"),
      ]);
      expect(summarizeUnread(messages, open, true)).toEqual({
        firstId: null,
        count: 2,
        more: true,
      });
    });
  });

  describe("with messages that arrive after the chat opened", () => {
    it("ignores them, however many", () => {
      const { messages, open } = opened(history());
      const later = [
        ...messages,
        agent("a5", "2026-10-27T12:14:00.000Z"),
        guardian("g3", "2026-10-27T12:15:00.000Z"),
      ].reduce<ChatMessage[]>((all, next) => mergeChatMessage(all, next), []);
      expect(summarizeUnread(later, open, false)).toEqual({ firstId: "a3", count: 2, more: false });
    });

    it("draws none in a chat that opened with nothing unread", () => {
      const { messages, open } = opened(history(), "2026-10-27T12:13:00.000Z");
      const later = mergeChatMessage(messages, agent("a5", "2026-10-27T12:14:00.000Z"));
      expect(summarizeUnread(later, open, false)).toBeNull();
    });

    it("ignores the live reply of a turn that was running when the chat opened", () => {
      const { messages, open } = opened(
        [
          guardian("u1", "2026-10-27T12:00:00.000Z", "turn-a"),
          agent("a1", "2026-10-27T12:01:00.000Z", { turnId: "turn-a" }),
          guardian("g1", "2026-10-27T12:05:00.000Z"),
        ],
        "2026-10-27T12:04:00.000Z",
      );
      expect(summarizeUnread(messages, open, false)).toBeNull();

      const later = mergeChatMessage(
        messages,
        agent("a2", "2026-10-27T12:06:00.000Z", { turnId: "turn-a" }),
      );
      expect(later.map((m) => m.id)).toEqual(["u1", "a1", "g1", "a2"]);
      expect(summarizeUnread(later, open, false)).toBeNull();
    });
  });
});

describe("useUnreadAtOpen", () => {
  const read = () => Promise.resolve("2026-10-27T12:10:00.000Z");

  it("holds the read mark and how far the opening history reached, once", async () => {
    const { result } = renderHook(() => useUnreadAtOpen({ chatId: "c", loadReadMark: read }));
    await act(async () => {});
    act(() => result.current.noteOpened([agent("a3", "2026-10-27T12:11:00.000Z")]));
    act(() => result.current.noteOpened([agent("later", "2026-10-27T12:20:00.000Z")]));
    expect(result.current.unread).toEqual({
      watermark: "2026-10-27T12:10:00.000Z",
      openedThrough: Math.floor(Date.parse("2026-10-27T12:11:00.000Z") / 1000),
    });
  });

  it("leaves a trace out of how far the opening history reached", async () => {
    const { result } = renderHook(() => useUnreadAtOpen({ chatId: "c", loadReadMark: read }));
    await act(async () => {});
    act(() =>
      result.current.noteOpened([
        agent("a3", "2026-10-27T12:11:00.000Z"),
        message("trace", "trace", "2026-10-27T12:30:00.000Z"),
      ]),
    );
    expect(result.current.unread?.openedThrough).toBe(
      Math.floor(Date.parse("2026-10-27T12:11:00.000Z") / 1000),
    );
  });

  it("has no unread state for a chat with no read mark or no opening history", async () => {
    const none = renderHook(() =>
      useUnreadAtOpen({ chatId: "c", loadReadMark: () => Promise.resolve(null) }),
    );
    await act(async () => {});
    act(() => none.result.current.noteOpened([agent("a1", "2026-10-27T12:11:00.000Z")]));
    expect(none.result.current.unread).toBeNull();

    const empty = renderHook(() => useUnreadAtOpen({ chatId: "c", loadReadMark: read }));
    await act(async () => {});
    act(() => empty.result.current.noteOpened([]));
    expect(empty.result.current.unread).toBeNull();
  });
});
