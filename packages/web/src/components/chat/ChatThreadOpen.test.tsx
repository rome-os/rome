// @rstest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { ChatMessage } from "@/lib/chat-types";
import "@/i18n";
import { EMPTY_LIVE_TEXT } from "@/hooks/live-text";
import { ThemeProvider } from "@/hooks/use-theme";
import { ConciergeTranscript } from "./ConciergeTranscript";
import { buildRows } from "./chat-view";
import type { BlockActions, LivePreview } from "./MessageList";
import {
  ChatThreadsProvider,
  type ThreadTimelineMessage,
  threadRepliesLines,
} from "./reply/chat-threads";
import { ReplyDraftProvider, useReplyDraftState } from "./reply/reply-draft";

// The "N replies" line of a Concierge chat's transcript (the iOS rule,
// rome-os/rome#1953): where it shows, what it counts, and that it opens the
// thread. A tap on a message itself opens nothing.

rs.mock("@/hooks/use-dashboard-identity", () => ({
  useDashboardIdentity: () => ({
    data: { kind: "guardian", userId: "seat", displayName: "Ray", avatarUrl: null },
  }),
}));

beforeEach(() => {
  rs.stubGlobal("IntersectionObserver", undefined);
  rs.stubGlobal(
    "matchMedia",
    rs.fn((query: string) => ({
      // A phone, where a tap would be the only way in if a message opened its thread.
      matches: query === "(hover: none)" || query === "(width < 48rem)",
      media: query,
      addEventListener: rs.fn(),
      removeEventListener: rs.fn(),
    })),
  );
});
afterEach(() => {
  cleanup();
  rs.unstubAllGlobals();
});

/** A guardian (`g`) or agent (`a`) message in thread `thread`. */
const g = (id: string, thread: string | null = id): ThreadTimelineMessage => ({
  id,
  role: "user",
  chatThreadId: thread,
});
const a = (id: string, thread: string | null): ThreadTimelineMessage => ({
  id,
  role: "assistant",
  chatThreadId: thread,
});

describe("threadRepliesLines", () => {
  it("shows none for a question and its answer alone", () => {
    expect(threadRepliesLines([g("q1"), a("a1", "q1")])).toEqual(new Map());
    expect(threadRepliesLines([g("q1"), a("a1", "q1"), a("a2", "q1")])).toEqual(new Map());
  });

  it("shows one for a thread of 4 or more messages, under its last agent message", () => {
    expect(threadRepliesLines([g("q1"), a("a1", "q1"), g("q2", "q1"), a("a2", "q1")])).toEqual(
      new Map([["a2", 3]]),
    );
  });

  it("shows one when the thread's first message is not in the run, so earlier parts exist", () => {
    // The first message is on an older page, not loaded.
    expect(threadRepliesLines([g("q2", "q1"), a("a2", "q1")])).toEqual(new Map([["a2", 1]]));
  });

  it("shows one when the thread goes on elsewhere", () => {
    const timeline = [g("q1"), a("a1", "q1"), g("w1"), a("w2", "w1"), g("q2", "q1"), a("a2", "q1")];
    // The first run has more of its thread later, and the last run has its
    // first message earlier. The weather run between them shows none, so
    // neither neighbours a line.
    expect(threadRepliesLines(timeline)).toEqual(
      new Map([
        ["a1", 3],
        ["a2", 3],
      ]),
    );
  });

  it("never shows on two neighbouring runs: the later one keeps it", () => {
    const timeline = [
      g("x1"),
      a("x2", "x1"),
      g("y1"),
      a("y2", "y1"),
      g("x3", "x1"),
      a("x4", "x1"),
      g("y3", "y1"),
      a("y4", "y1"),
    ];
    // Every run qualifies; each later run takes the line from the one before it.
    expect(threadRepliesLines(timeline)).toEqual(
      new Map([
        ["y4", 3],
        ["y2", 3],
      ]),
    );
  });

  it("puts none under the guardian's messages, nor on a run with no agent message", () => {
    expect(threadRepliesLines([g("q1"), g("q2", "q1"), g("q3", "q1"), g("q4", "q1")])).toEqual(
      new Map(),
    );
  });

  it("follows a message the Concierge places in a thread later", () => {
    const loaded = [g("q1"), a("a1", "q1"), g("q2", null), a("a2", null)];
    expect(threadRepliesLines(loaded)).toEqual(new Map());
    // The live event places q2 and a2 in q1's thread: one run of 4.
    const placed = loaded.map((m) => (m.chatThreadId === null ? { ...m, chatThreadId: "q1" } : m));
    expect(threadRepliesLines(placed)).toEqual(new Map([["a2", 3]]));
  });
});

const at = (minute: number) => new Date(2026, 10, 9, 9, minute).toISOString();
const message = (
  id: string,
  role: "user" | "assistant",
  text: string,
  chatThreadId: string,
  minute: number,
): ChatMessage =>
  ({
    id,
    sessionId: "concierge",
    turnId: role === "assistant" ? `t-${id}` : null,
    role,
    content: JSON.stringify([{ type: "text", content: text }]),
    createdAt: at(minute),
    chatThreadId,
  }) as ChatMessage;

const messages = [
  message("m1", "user", "Plan Kyoto in April", "m1", 0),
  message("a1", "assistant", "Hotels first, then the days.", "m1", 1),
  message("m2", "user", "Which one is closest?", "m1", 2),
  message("a2", "assistant", "The river one.", "m1", 3),
];

const actions = {
  onApprovalResolved: () => {},
  onSubmitAppComponent: () => {},
  onDismissAppComponent: () => {},
  interactionResults: new Map(),
} as BlockActions;
const idle = {
  isStreaming: false,
  runningTurnId: null,
  snapshot: null,
  textStore: EMPTY_LIVE_TEXT,
  identity: { name: "Rome", iconUrl: null },
} as LivePreview;

function renderTranscript() {
  const box: { thread: string | null } = { thread: null };
  const rows = buildRows(messages, new Map(), idle.identity, {
    runningTurnId: null,
    isStreaming: false,
  });
  function Chat() {
    const draft = useReplyDraftState({
      chatId: "concierge",
      sessionId: "concierge",
      messageIds: new Set(messages.map((m) => m.id)),
      jump: () => {},
      focusComposer: () => {},
      threads: true,
    });
    box.thread = draft.thread;
    return (
      <MemoryRouter>
        <ReplyDraftProvider value={draft}>
          <ThemeProvider>
            <ChatThreadsProvider value={{ lines: threadRepliesLines(messages) }}>
              <ConciergeTranscript
                rows={rows}
                live={idle}
                actions={actions}
                contentRef={() => {}}
              />
            </ChatThreadsProvider>
          </ThemeProvider>
        </ReplyDraftProvider>
      </MemoryRouter>
    );
  }
  render(<Chat />);
  return () => box.thread;
}

describe("the replies line in the transcript", () => {
  it("sits under the run's last agent message and opens its thread", () => {
    const thread = renderTranscript();
    const line = screen.getByRole("button", { name: "3 replies" });
    expect(line.getAttribute("data-thread-replies")).toBe("a2");
    fireEvent.click(line);
    expect(thread()).toBe("a2");
  });

  it("is the way in from the transcript: a tap on a message opens nothing", () => {
    const thread = renderTranscript();
    fireEvent.click(screen.getByText("Hotels first, then the days."));
    expect(thread()).toBeNull();
  });
});
