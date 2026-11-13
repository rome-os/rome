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
  return { messages, open: { watermark: mark, memberIds: new Set(messages.map((m) => m.id)) } };
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

  describe("with older pages", () => {
    // The server pages whole turns, newest first by each turn's earliest message.
    const turnPages = (all: ChatMessage[], limit: number) => {
      const turns = new Map<string, ChatMessage[]>();
      for (const m of all) turns.set(m.turnId ?? m.id, [...(turns.get(m.turnId ?? m.id) ?? []), m]);
      const start = (turn: ChatMessage[]) => Math.min(...turn.map((m) => Date.parse(m.createdAt)));
      const newestFirst = [...turns.values()].sort((a, b) => start(b) - start(a));
      const pages: ChatMessage[][] = [];
      for (let i = 0; i < newestFirst.length; i += limit)
        pages.push(newestFirst.slice(i, i + limit).flat());
      return pages;
    };
    const THREE_TURNS = () => [
      // Turn A began first and replies after the mark.
      guardian("uA", "2026-10-27T12:00:00.000Z", "turn-a"),
      agent("aA1", "2026-10-27T12:11:00.000Z", { turnId: "turn-a" }),
      guardian("uB", "2026-10-27T12:05:00.000Z", "turn-b"),
      agent("aB1", "2026-10-27T12:06:00.000Z", { turnId: "turn-b" }),
      guardian("uC", "2026-10-27T12:12:00.000Z", "turn-c"),
      agent("aC1", "2026-10-27T12:13:00.000Z", { turnId: "turn-c" }),
    ];
    const ids = (messages: ChatMessage[]) => new Set(messages.map((m) => m.id));

    it("counts an unread reply of a turn that began before the opening page, once its page loads", () => {
      const [first, older] = turnPages(THREE_TURNS(), 2);
      const opening = orderChatMessages(first);
      const open: UnreadAtOpen = { watermark: MARK, memberIds: ids(opening) };
      // The opening page starts at 12:05 and its oldest turn is read: the run ends there.
      expect(summarizeUnread(opening, open, true)).toEqual({
        firstId: "aC1",
        count: 1,
        more: false,
      });

      const loaded = mergeFetchedChatMessages(opening, older);
      const member: UnreadAtOpen = {
        watermark: MARK,
        memberIds: new Set([...open.memberIds, ...ids(older)]),
      };
      expect(loaded.map((m) => m.id)).toEqual(["uA", "aA1", "uB", "aB1", "uC", "aC1"]);
      expect(summarizeUnread(loaded, member, false)).toEqual({
        firstId: "aA1",
        count: 2,
        more: false,
      });
    });

    it("keeps looking while the oldest loaded turn has an unread reply, whatever read messages follow it", () => {
      const turns = [
        guardian("uB", "2026-10-27T12:05:00.000Z", "turn-b"),
        agent("aB1", "2026-10-27T12:11:00.000Z", { turnId: "turn-b" }),
        guardian("uD", "2026-10-27T12:06:00.000Z", "turn-d"),
        agent("aD1", "2026-10-27T12:07:00.000Z", { turnId: "turn-d" }),
        guardian("uC", "2026-10-27T12:12:00.000Z", "turn-c"),
        agent("aC1", "2026-10-27T12:13:00.000Z", { turnId: "turn-c" }),
      ];
      const { messages, open } = opened(turns);
      expect(messages.map((m) => m.id)).toEqual(["uB", "aB1", "uD", "aD1", "uC", "aC1"]);
      expect(summarizeUnread(messages, open, true)).toEqual({
        firstId: null,
        count: 2,
        more: true,
      });
      expect(summarizeUnread(messages, open, false)).toEqual({
        firstId: "aB1",
        count: 2,
        more: false,
      });
    });

    it("has the first message once the page that holds a read oldest turn loads", () => {
      const all = [
        guardian("u0", "2026-10-27T11:00:00.000Z", "turn-0"),
        agent("a0", "2026-10-27T11:01:00.000Z", { turnId: "turn-0" }),
        guardian("uB", "2026-10-27T12:05:00.000Z", "turn-b"),
        agent("aB1", "2026-10-27T12:11:00.000Z", { turnId: "turn-b" }),
        guardian("uC", "2026-10-27T12:12:00.000Z", "turn-c"),
        agent("aC1", "2026-10-27T12:13:00.000Z", { turnId: "turn-c" }),
      ];
      const [first, older] = turnPages(all, 2);
      const opening = orderChatMessages(first);
      const open: UnreadAtOpen = { watermark: MARK, memberIds: ids(opening) };
      expect(summarizeUnread(opening, open, true)).toEqual({ firstId: null, count: 2, more: true });
      const loaded = mergeFetchedChatMessages(opening, older);
      const member: UnreadAtOpen = {
        watermark: MARK,
        memberIds: new Set([...open.memberIds, ...ids(older)]),
      };
      expect(summarizeUnread(loaded, member, false)).toEqual({
        firstId: "aB1",
        count: 2,
        more: false,
      });
    });

    it("takes the oldest loaded message as the first when no older page exists", () => {
      const { messages, open } = opened([
        agent("a3", "2026-10-27T12:11:00.000Z"),
        agent("a4", "2026-10-27T12:13:00.000Z"),
      ]);
      expect(summarizeUnread(messages, open, false)).toEqual({
        firstId: "a3",
        count: 2,
        more: false,
      });
    });

    it("ignores a live reply to an older turn, which an older page never brought", () => {
      const [first] = turnPages(THREE_TURNS(), 2);
      const opening = orderChatMessages(first);
      const open: UnreadAtOpen = { watermark: MARK, memberIds: ids(opening) };
      const live = mergeChatMessage(
        opening,
        agent("aB2", "2026-10-27T12:14:00.000Z", { turnId: "turn-b" }),
      );
      expect(summarizeUnread(live, open, true)).toEqual({ firstId: "aC1", count: 1, more: false });
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

    it("ignores a live message that sorts before the opening tail, in a turn still running", () => {
      // Turn A is running: a1 is read. The guardian's message g1 belongs to no turn. A's next
      // message sorts by its turn's start, which is before g1.
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
      expect(later.map((m) => m.id)).toEqual(["u1", "a1", "a2", "g1"]);
      expect(summarizeUnread(later, open, false)).toBeNull();
    });

    it("keeps the divider on the opening messages when one arrives before the opening tail", () => {
      const { messages, open } = opened(
        [
          guardian("u1", "2026-10-27T12:00:00.000Z", "turn-a"),
          agent("a1", "2026-10-27T12:09:00.000Z", { turnId: "turn-a" }),
          agent("a2", "2026-10-27T12:11:00.000Z", { turnId: "turn-a" }),
          guardian("g1", "2026-10-27T12:12:00.000Z"),
        ],
        "2026-10-27T12:10:00.000Z",
      );
      const later = mergeChatMessage(
        messages,
        agent("a3", "2026-10-27T12:13:00.000Z", { turnId: "turn-a" }),
      );
      expect(later.map((m) => m.id)).toEqual(["u1", "a1", "a2", "a3", "g1"]);
      expect(summarizeUnread(later, open, false)).toEqual({ firstId: "a2", count: 1, more: false });
    });
  });

  it("does not count a read message that the turn order puts after an unread one", () => {
    // Turn A starts first and has an unread message. Turn B starts later and is read.
    const { messages, open } = opened([
      guardian("uA", "2026-10-27T12:00:00.000Z", "turn-a"),
      guardian("uB", "2026-10-27T12:05:00.000Z", "turn-b"),
      agent("aB", "2026-10-27T12:06:00.000Z", { turnId: "turn-b" }),
      agent("aA", "2026-10-27T12:12:00.000Z", { turnId: "turn-a" }),
    ]);
    expect(messages.map((m) => m.id)).toEqual(["uA", "aA", "uB", "aB"]);
    expect(summarizeUnread(messages, open, false)).toEqual({
      firstId: "aA",
      count: 1,
      more: false,
    });
  });
});

describe("useUnreadAtOpen", () => {
  const read = () => Promise.resolve("2026-10-27T12:10:00.000Z");

  it("holds the opening ids and the older pages, and never a live message", async () => {
    const { result } = renderHook(() => useUnreadAtOpen({ chatId: "c", loadReadMark: read }));
    await act(async () => {});
    act(() => result.current.noteOpened([agent("a3", "2026-10-27T12:11:00.000Z")]));
    act(() => result.current.noteOpened([agent("later", "2026-10-27T12:20:00.000Z")]));
    act(() => result.current.noteOlder([agent("a1", "2026-10-27T12:00:00.000Z")]));
    expect([...result.current.unread!.memberIds].sort()).toEqual(["a1", "a3"]);
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
