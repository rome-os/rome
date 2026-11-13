import { describe, expect, it } from "@rstest/core";
import type { ChatMessage } from "@/lib/chat-types";
import { summarizeUnread } from "./concierge-unread";

const MARK = "2026-10-27T12:10:00.000Z";
const text = (content: string) => JSON.stringify([{ type: "text", content }]);

function message(
  id: string,
  role: ChatMessage["role"],
  createdAt: string,
  content = text(id),
): ChatMessage {
  return { id, sessionId: "concierge", role, content, createdAt };
}

const agent = (id: string, createdAt: string, content?: string) =>
  message(id, "assistant", createdAt, content);
const guardian = (id: string, createdAt: string) => message(id, "user", createdAt);

// a1 and a2 were read, a3 and a4 were not.
const history = [
  agent("a1", "2026-10-27T12:00:00.000Z"),
  guardian("g1", "2026-10-27T12:05:00.000Z"),
  agent("a2", "2026-10-27T12:10:00.000Z"),
  agent("a3", "2026-10-27T12:11:00.000Z"),
  guardian("g2", "2026-10-27T12:12:00.000Z"),
  agent("a4", "2026-10-27T12:13:00.000Z"),
];
const open = { watermark: MARK, newestId: "a4" };

describe("summarizeUnread", () => {
  it("names the first agent message created after the read mark and counts those after it", () => {
    expect(summarizeUnread(history, open, false)).toEqual({ firstId: "a3", count: 2, more: false });
  });

  it("counts a message in the same second as the read mark as read, as the server does", () => {
    const late = [agent("a1", "2026-10-27T12:10:00.900Z"), agent("a2", "2026-10-27T12:10:01.000Z")];
    expect(summarizeUnread(late, { watermark: MARK, newestId: "a2" }, false)).toEqual({
      firstId: "a2",
      count: 1,
      more: false,
    });
  });

  it("leaves the guardian's own messages out", () => {
    const own = [
      agent("a1", "2026-10-27T12:00:00.000Z"),
      guardian("g1", "2026-10-27T12:20:00.000Z"),
    ];
    expect(summarizeUnread(own, { watermark: MARK, newestId: "g1" }, false)).toBeNull();
  });

  it("returns null when nothing is unread", () => {
    expect(
      summarizeUnread(history, { watermark: "2026-10-27T12:13:00.000Z", newestId: "a4" }, false),
    ).toBeNull();
  });

  it("ignores messages that arrived after the chat opened, however many", () => {
    const later = [
      ...history,
      agent("a5", "2026-10-27T12:14:00.000Z"),
      guardian("g3", "2026-10-27T12:15:00.000Z"),
    ];
    expect(summarizeUnread(later, open, false)).toEqual({ firstId: "a3", count: 2, more: false });
  });

  it("finds no unread message in a chat that opened with none, when one arrives", () => {
    const caughtUp = { watermark: "2026-10-27T12:13:00.000Z", newestId: "a4" };
    const later = [...history, agent("a5", "2026-10-27T12:14:00.000Z")];
    expect(summarizeUnread(later, caughtUp, false)).toBeNull();
  });

  it("returns null, never a later message, once the newest message at open is gone", () => {
    const rewritten = history
      .filter((m) => m.id !== "a4")
      .concat(agent("a5", "2026-10-27T12:14:00.000Z"));
    expect(summarizeUnread(rewritten, open, false)).toBeNull();
  });

  it("counts only the unread messages the chat draws", () => {
    const withHidden = [
      agent("a1", "2026-10-27T12:00:00.000Z"),
      agent("a2", "2026-10-27T12:11:00.000Z", text(" ")),
      agent("a3", "2026-10-27T12:12:00.000Z"),
      agent("a4", "2026-10-27T12:13:00.000Z"),
    ];
    expect(summarizeUnread(withHidden, open, false)).toEqual({
      firstId: "a3",
      count: 2,
      more: false,
    });
  });

  it("does not count a model-switch notice as a message", () => {
    const notice = JSON.stringify([{ type: "quota_switch", from: "a", to: "b", model: "m" }]);
    const rows = [
      agent("a1", "2026-10-27T12:00:00.000Z"),
      agent("a2", "2026-10-27T12:11:00.000Z", notice),
      agent("a3", "2026-10-27T12:12:00.000Z"),
    ];
    expect(summarizeUnread(rows, { watermark: MARK, newestId: "a3" }, false)).toEqual({
      firstId: "a3",
      count: 1,
      more: false,
    });
  });

  it("returns null when every unread message draws nothing", () => {
    const hidden = [
      agent("a1", "2026-10-27T12:00:00.000Z"),
      agent("a2", "2026-10-27T12:11:00.000Z", text(" ")),
    ];
    expect(summarizeUnread(hidden, { watermark: MARK, newestId: "a2" }, false)).toBeNull();
  });

  it("has no first message yet while the unread run reaches the oldest loaded page", () => {
    const run = [agent("a3", "2026-10-27T12:11:00.000Z"), agent("a4", "2026-10-27T12:13:00.000Z")];
    expect(summarizeUnread(run, open, true)).toEqual({ firstId: null, count: 2, more: true });
  });

  it("finds the first message once an older page shows a read one before it", () => {
    const loaded = [agent("a2", "2026-10-27T12:10:00.000Z"), ...history.slice(3)];
    expect(summarizeUnread(loaded, open, true)).toEqual({ firstId: "a3", count: 2, more: false });
  });

  it("takes the oldest loaded message as the first when no older page exists", () => {
    const run = [agent("a3", "2026-10-27T12:11:00.000Z"), agent("a4", "2026-10-27T12:13:00.000Z")];
    expect(summarizeUnread(run, open, false)).toEqual({ firstId: "a3", count: 2, more: false });
  });

  it("returns null for a read mark it cannot read", () => {
    expect(summarizeUnread(history, { watermark: "yesterday", newestId: "a4" }, false)).toBeNull();
  });
});
