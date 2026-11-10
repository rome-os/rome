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
import { ChatThreadsProvider, threadReplyCounts } from "./reply/chat-threads";
import { ReplyDraftProvider, useReplyDraftState } from "./reply/reply-draft";

// The "N replies" line into a Concierge chat's thread view from its
// transcript, and the tap on a bubble, which opens no thread on any screen.

rs.mock("@/hooks/use-dashboard-identity", () => ({
  useDashboardIdentity: () => ({
    data: { kind: "guardian", userId: "seat", displayName: "Ray", avatarUrl: null },
  }),
}));

function media({ phone = false, touch = false } = {}) {
  rs.stubGlobal(
    "matchMedia",
    rs.fn((query: string) => ({
      matches: (query === "(width < 48rem)" && phone) || (query === "(hover: none)" && touch),
      media: query,
      addEventListener: rs.fn(),
      removeEventListener: rs.fn(),
    })),
  );
}

beforeEach(() => {
  rs.stubGlobal("IntersectionObserver", undefined);
  media();
});
afterEach(() => {
  cleanup();
  rs.unstubAllGlobals();
});

const at = (minute: number) => new Date(2026, 10, 9, 9, minute).toISOString();
const message = (
  id: string,
  role: "user" | "assistant",
  text: string,
  chatThreadId: string | null,
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
  message("m2", "user", "What's the weather?", "m2", 2),
  message("a2", "assistant", "Sunny all week, see [the forecast](https://example.com).", "m2", 3),
  message("m3", "user", "Book the river one.", "m1", 4),
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

/** The main transcript with the real draft of a chat that keeps chat threads. */
function renderTranscript({ threadView = false } = {}) {
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
    const transcript = (
      <ConciergeTranscript rows={rows} live={idle} actions={actions} contentRef={() => {}} />
    );
    return (
      <MemoryRouter>
        <ReplyDraftProvider value={draft}>
          <ThemeProvider>
            {threadView ? (
              transcript
            ) : (
              <ChatThreadsProvider value={{ replies: threadReplyCounts(messages) }}>
                {transcript}
              </ChatThreadsProvider>
            )}
          </ThemeProvider>
        </ReplyDraftProvider>
      </MemoryRouter>
    );
  }
  render(<Chat />);
  return () => box.thread;
}

describe("threadReplyCounts", () => {
  it("counts every message in a thread but its first", () => {
    expect(threadReplyCounts(messages)).toEqual(
      new Map([
        ["m1", 2],
        ["m2", 1],
      ]),
    );
  });
});

describe("the replies line under a thread's first message", () => {
  it("says how many replies the thread has and opens it", () => {
    const thread = renderTranscript();
    expect(screen.getByRole("button", { name: "1 reply" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "2 replies" }));
    expect(thread()).toBe("m1");
  });

  it("is not in the thread view's own transcript", () => {
    renderTranscript({ threadView: true });
    expect(screen.queryByRole("button", { name: /repl(y|ies)$/ })).toBeNull();
  });
});

describe("a tap on an agent bubble on a phone", () => {
  it("shows its details and opens no thread", () => {
    media({ phone: true, touch: true });
    const thread = renderTranscript();
    expect(screen.queryByRole("button", { name: "Reply" })).toBeNull();
    fireEvent.click(screen.getByText("Hotels first, then the days."));
    expect(thread()).toBeNull();
    // The details row, with its Reply, opens under the bubble.
    expect(screen.getByRole("button", { name: "Reply" })).toBeTruthy();
  });
});
