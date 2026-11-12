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
  taskThreads,
  threadLabels,
} from "./reply/chat-threads";
import { ReplyDraftProvider, useReplyDraftState } from "./reply/reply-draft";

// The thread label under the agent's messages in a Concierge chat's
// transcript: where it shows, what it names, and that it opens the thread. A
// tap on a message itself opens nothing.

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

/** Where each label goes and what thread it names, as `[messageId, thread]` pairs. */
const where = (labels: ReturnType<typeof threadLabels>) =>
  [...labels].map(([id, label]) => [id, label.thread]);

/** The tasks whose threads start at q1 and q2. */
const tasks = new Map([
  ["q1", "Flights"],
  ["q2", "Hotels"],
]);

describe("threadLabels", () => {
  it("shows none for messages in no thread: a plain question and its answer", () => {
    expect(threadLabels([free("q1"), free("a1", "assistant")], tasks)).toEqual(new Map());
  });

  it("labels every agent message in a task's thread, and none of the guardian's", () => {
    expect(
      where(
        threadLabels([g("q1"), a("a1", "q1"), g("q2", "q1"), free("w1"), a("a2", "q1")], tasks),
      ),
    ).toEqual([
      ["a1", "q1"],
      ["a2", "q1"],
    ]);
  });

  it("names a task's thread by its title, from any of its messages", () => {
    const labels = threadLabels([{ ...g("q1"), chatThreadTitle: "Tokyo weather" }, a("a1", "q1")]);
    expect(labels.get("a1")).toEqual({ thread: "q1", title: "Tokyo weather" });
  });

  it("shows no label in a thread no task has, from before", () => {
    const root = {
      ...free("r1", "assistant"),
      content: JSON.stringify([{ type: "text", content: "Sunny,\n24°" }]),
    };
    const labels = threadLabels([root, g("q2", "r1"), a("a2", "r1"), a("a3", "gone")]);
    expect(labels).toEqual(new Map());
    expect(taskThreads([root, g("q2", "r1"), a("a2", "r1")]).threads).toEqual(new Map());
  });

  it("knows the task thread of the guardian's messages too", () => {
    expect(taskThreads([g("q1"), g("r1", "q1"), free("w1")], tasks).threads).toEqual(
      new Map([
        ["q1", "q1"],
        ["r1", "q1"],
      ]),
    );
  });

  it("drops the label of a thread whose task left the chat", () => {
    const loaded = [{ ...g("q1"), chatThreadTitle: "Flights" }, a("a1", "q1")];
    expect(threadLabels(loaded).get("a1")).toEqual({ thread: "q1", title: "Flights" });
    expect(threadLabels(loaded, new Map([["q1", null]]))).toEqual(new Map());
    expect(taskThreads(loaded, new Map([["q1", null]])).threads).toEqual(new Map());
  });

  it("takes a title a live placement told", () => {
    const labels = threadLabels([g("q1"), a("a1", "q1")], new Map([["q1", "Flights"]]));
    expect(labels.get("a1")).toMatchObject({ title: "Flights" });
  });
});

describe("live thread placements", () => {
  it("apply while the loaded message still is where they were made", () => {
    const loaded = [g("q1"), a("a1", "q1"), free("q2"), free("a2", "assistant")];
    const live = new Map<string, ThreadPlacement>([
      ["q2", { from: null, to: "q1" }],
      ["a2", { from: null, to: "q1" }],
    ]);
    expect(where(threadLabels(placed(loaded, live), tasks))).toEqual([
      ["a1", "q1"],
      ["a2", "q1"],
    ]);
  });

  it("give way to a reload that says otherwise", () => {
    const live = new Map<string, ThreadPlacement>([["a2", { from: null, to: "q1" }]]);
    const reloaded = [g("q1"), a("a1", "q1"), g("q2", "q2"), a("a2", "q2")];
    expect(where(threadLabels(placed(reloaded, live), tasks))).toEqual([
      ["a1", "q1"],
      ["a2", "q2"],
    ]);
  });

  it("build on a reload between two placements", () => {
    let live = placeLive(new Map(), "a2", "q1", null);
    const reloaded = [g("q1"), a("a1", "q1"), a("a2", "q1")];
    expect(where(threadLabels(placed(reloaded, live), tasks))).toEqual([
      ["a1", "q1"],
      ["a2", "q1"],
    ]);
    live = placeLive(live, "a2", "q2", "q1");
    expect(where(threadLabels(placed(reloaded, live), tasks))).toEqual([
      ["a1", "q1"],
      ["a2", "q2"],
    ]);
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
  { ...message("m1", "user", "Plan Kyoto in April", "m1", 0), chatThreadTitle: "Kyoto trip" },
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
            <ChatThreadsProvider value={{ labels: threadLabels(messages) }}>
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

describe("the thread label in the transcript", () => {
  it("sits under each of the agent's messages in the thread, names its task, and opens it", () => {
    const thread = renderTranscript();
    const labels = screen.getAllByRole("button", { name: "Kyoto trip" });
    expect(labels).toHaveLength(2);
    expect(labels[0]?.getAttribute("title")).toBe("Kyoto trip");
    // The thread view loads a thread named by any of its messages.
    fireEvent.click(labels[1]!);
    expect(thread()).toBe("a2");
  });

  it("sits under none of the guardian's messages", () => {
    renderTranscript();
    const labelled = screen
      .getAllByRole("button", { name: "Kyoto trip" })
      .map((label) => label.previousElementSibling?.textContent ?? "");
    expect(labelled.some((text) => text.includes("Plan Kyoto in April"))).toBe(false);
    expect(labelled.some((text) => text.includes("Which one is closest?"))).toBe(false);
  });

  it("is the way in from the transcript: a tap on a message opens nothing", () => {
    const thread = renderTranscript();
    fireEvent.click(screen.getByText("Hotels first, then the days."));
    expect(thread()).toBeNull();
  });
});
