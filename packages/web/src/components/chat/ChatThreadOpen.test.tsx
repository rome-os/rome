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
  placed,
  placeLive,
  type ThreadPlacement,
  type ThreadTimelineMessage,
  threadRepliesLines,
} from "./reply/chat-threads";
import { ReplyDraftProvider, useReplyDraftState } from "./reply/reply-draft";

// The "N replies" line of a Concierge chat's transcript: where it shows, what
// it counts, and that it opens the thread. A tap on a message itself opens
// nothing.

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

/** A message in no chat thread. */
const free = (id: string, role: "user" | "assistant" = "user"): ThreadTimelineMessage => ({
  id,
  role,
  chatThreadId: null,
});

describe("threadRepliesLines", () => {
  it("shows none for messages in no thread: a plain question and its answer", () => {
    expect(threadRepliesLines([free("q1"), free("a1", "assistant")])).toEqual(new Map());
  });

  it("6. shows a thread said in one stretch under its root only", () => {
    expect(threadRepliesLines([g("q1"), a("a1", "q1"), g("q2", "q1"), a("a2", "q1")])).toEqual(
      new Map([["q1", 3]]),
    );
  });

  it("6. shows it under its newest message too when another message lies between", () => {
    expect(
      threadRepliesLines([
        g("q1"),
        a("a1", "q1"),
        free("w1"),
        free("w2", "assistant"),
        a("a2", "q1"),
      ]),
    ).toEqual(
      new Map([
        ["q1", 2],
        ["a2", 2],
      ]),
    );
  });

  it("7. shows it under its newest message only when its root is not loaded", () => {
    expect(threadRepliesLines([g("q2", "q1"), free("w1"), a("a2", "q1")])).toEqual(
      new Map([["a2", 2]]),
    );
  });

  it("8. counts the same on both lines, and moves the newest line as a message arrives", () => {
    const before = [g("q1"), a("a1", "q1"), free("w1"), a("a2", "q1")];
    expect(threadRepliesLines(before)).toEqual(
      new Map([
        ["q1", 2],
        ["a2", 2],
      ]),
    );
    expect(threadRepliesLines([...before, free("w2"), g("q3", "q1")])).toEqual(
      new Map([
        ["q1", 3],
        ["q3", 3],
      ]),
    );
  });

  it("counts a root that was in no thread when the thread started at it", () => {
    expect(threadRepliesLines([free("q1"), free("ack", "assistant"), a("result", "q1")])).toEqual(
      new Map([
        ["q1", 1],
        ["result", 1],
      ]),
    );
  });

  it("shows none for a root with no replies", () => {
    expect(threadRepliesLines([g("q1")])).toEqual(new Map());
  });
});

describe("live thread placements", () => {
  it("apply while the loaded message still is where they were made", () => {
    const loaded = [g("q1"), a("a1", "q1"), free("q2"), free("a2", "assistant")];
    const live = new Map<string, ThreadPlacement>([
      ["q2", { from: null, to: "q1" }],
      ["a2", { from: null, to: "q1" }],
    ]);
    expect(threadRepliesLines(placed(loaded, live))).toEqual(new Map([["q1", 3]]));
  });

  it("give way to a reload that says otherwise", () => {
    const live = new Map<string, ThreadPlacement>([["q2", { from: null, to: "q1" }]]);
    const reloaded = [g("q1"), a("a1", "q1"), g("q2", "q2"), a("a2", "q2")];
    expect(threadRepliesLines(placed(reloaded, live))).toEqual(
      new Map([
        ["q1", 1],
        ["q2", 1],
      ]),
    );
  });

  it("build on a reload between two placements", () => {
    let live = placeLive(new Map(), "q2", "q1", null);
    const reloaded = [g("q1"), a("a1", "q1"), g("q2", "q1")];
    expect(threadRepliesLines(placed(reloaded, live))).toEqual(new Map([["q1", 2]]));
    live = placeLive(live, "q2", "q2", "q1");
    expect(threadRepliesLines(placed(reloaded, live))).toEqual(new Map([["q1", 1]]));
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
  it("sits under the thread's root and opens its thread", () => {
    const thread = renderTranscript();
    const line = screen.getByRole("button", { name: "3 replies" });
    expect(line.getAttribute("data-thread-replies")).toBe("m1");
    fireEvent.click(line);
    expect(thread()).toBe("m1");
  });

  it("is the way in from the transcript: a tap on a message opens nothing", () => {
    const thread = renderTranscript();
    fireEvent.click(screen.getByText("Hotels first, then the days."));
    expect(thread()).toBeNull();
  });
});
