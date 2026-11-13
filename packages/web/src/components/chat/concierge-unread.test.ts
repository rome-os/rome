import { describe, expect, it } from "@rstest/core";
import { mergeChatMessage, orderChatMessages } from "@/lib/chat-message-ordering";
import type { ChatMessage } from "@/lib/chat-types";
import { openingHistory, summarizeUnread, type UnreadAtOpen } from "./concierge-unread";

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
  return { messages, open: { watermark: mark, ...openingHistory(messages)! } };
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
    const run = () => [
      agent("a3", "2026-10-27T12:11:00.000Z"),
      agent("a4", "2026-10-27T12:13:00.000Z"),
    ];

    it("has no first message yet while the unread run reaches the oldest loaded page", () => {
      const { messages, open } = opened(run());
      expect(summarizeUnread(messages, open, true)).toEqual({
        firstId: null,
        count: 2,
        more: true,
      });
    });

    it("finds the first message once an older page shows a read one before it", () => {
      const { messages, open } = opened(run());
      const older = orderChatMessages([...messages, agent("a2", "2026-10-27T12:10:00.000Z")]);
      expect(summarizeUnread(older, open, true)).toEqual({ firstId: "a3", count: 2, more: false });
    });

    it("counts an older unread page as it loads, and stays open while the run goes on", () => {
      const { messages, open } = opened(run());
      const older = orderChatMessages([...messages, agent("a2b", "2026-10-27T12:10:30.000Z")]);
      expect(summarizeUnread(older, open, true)).toEqual({ firstId: null, count: 3, more: true });
      expect(summarizeUnread(older, open, false)).toEqual({
        firstId: "a2b",
        count: 3,
        more: false,
      });
    });

    it("takes the oldest loaded message as the first when no older page exists", () => {
      const { messages, open } = opened(run());
      expect(summarizeUnread(messages, open, false)).toEqual({
        firstId: "a3",
        count: 2,
        more: false,
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
