// @rstest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ComponentProps } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
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
  chatThreadsOf,
  type ThreadTimelineMessage,
  threadLabels,
  threadsOf,
} from "./reply/chat-threads";
import { ReplyBar } from "./reply/ReplyBar";
import { ReplyDraftProvider, useReplyDraftState } from "./reply/reply-draft";

// The thread label under the agent's messages in a Concierge chat's
// transcript: where it shows, what it names, and that it focuses the chat on
// the thread. A tap on a message itself opens nothing. With a thread in focus,
// the transcript marks what is outside it.

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

/** The name each thread of these fixtures carries on its messages. */
const NAMES: Record<string, string> = { q1: "Flights", q2: "Hotels" };

/** A message the server sent in thread `thread`, null when it is alone in its own, named as the server names it. */
const sent = (
  id: string,
  role: "user" | "assistant",
  thread: string | null,
): ThreadTimelineMessage => ({
  id,
  role,
  chatThreadId: thread,
  ...(thread && NAMES[thread] ? { chatThreadTitle: NAMES[thread] } : {}),
});

/** A guardian (`g`) or agent (`a`) message in thread `thread`. */
const g = (id: string, thread: string | null = null) => sent(id, "user", thread);
const a = (id: string, thread: string | null) => sent(id, "assistant", thread);

/** A message in no thread: nothing replies to it. */
const free = (id: string, role: "user" | "assistant" = "user"): ThreadTimelineMessage =>
  sent(id, role, null);

/** Where each label goes and what thread it names, as `[messageId, thread]` pairs. */
const where = (labels: ReturnType<typeof threadLabels>) =>
  [...labels].map(([id, label]) => [id, label.thread]);

describe("threadsOf", () => {
  it("puts a message in the thread its chatThreadId names, and a root delivered with none in it once a reply says so", () => {
    // The root arrived alone, with null, and its reply arrived after.
    const { roots } = threadsOf([g("q1"), a("a1", "q1"), free("w1")]);
    expect(roots).toEqual(
      new Map([
        ["q1", "q1"],
        ["a1", "q1"],
      ]),
    );
  });

  it("leaves a message nothing replies to in no thread, and a reply whose root is not loaded in the thread", () => {
    const { roots } = threadsOf([g("q9"), a("a1", "q1"), free("w1", "assistant")]);
    expect(roots).toEqual(new Map([["a1", "q1"]]));
  });

  it("names a thread by the title any of its messages carries", () => {
    expect(threadsOf([g("q1"), a("a1", "q1")]).titles).toEqual(new Map([["q1", "Flights"]]));
    expect(threadsOf([g("q1", "q1"), a("a1", "q1")]).titles).toEqual(new Map([["q1", "Flights"]]));
    expect(threadsOf([g("q7"), a("a1", "q7")]).titles).toEqual(new Map());
  });

  it("names a thread no task started in by the start of its root's text", () => {
    const root = (content: string): ThreadTimelineMessage => ({
      ...g("r"),
      content: JSON.stringify([{ type: "text", content }]),
    });
    const named = (text: string) => threadsOf([root(text), a("a1", "r")]).titles.get("r");
    expect(named("Plan Kyoto in April")).toBe("Plan Kyoto in April");
    // The first line only, as plain reading text.
    expect(named("## Plan Kyoto\nthen the hotels")).toBe("Plan Kyoto");
    // Cut short, with an ellipsis.
    const cut = named("Compare every ryokan along the Kamo river for the April trip please");
    expect(cut).toBe("Compare every ryokan along the Kamo river for the…");
    expect(Array.from(cut!)).toHaveLength(50);
    // A task's title wins, and a root with no text, or not loaded, gives none.
    expect(threadsOf([root("Plan"), a("a1", "q1")]).titles.get("q1")).toBe("Flights");
    expect(named("   ")).toBeUndefined();
    expect(threadsOf([g("r"), a("a1", "r")]).titles.get("r")).toBeUndefined();
    expect(threadsOf([a("a1", "r")]).titles.get("r")).toBeUndefined();
  });

  it("gives a split thread with no task a label named by its root's text", () => {
    const root = {
      ...g("r"),
      content: JSON.stringify([{ type: "text", content: "Plan Kyoto in April" }]),
    };
    const labels = threadLabels([root, free("w1"), a("a1", "r")]);
    expect(labels.get("a1")).toEqual({ thread: "r", title: "Plan Kyoto in April" });
  });

  it("knows the guardian's messages in a thread too", () => {
    expect([...threadsOf([g("q1"), g("r1", "q1"), free("w1")]).roots]).toEqual([
      ["q1", "q1"],
      ["r1", "q1"],
    ]);
  });
});

describe("threadLabels", () => {
  it("shows none for messages in no thread: a plain question and its answer", () => {
    expect(threadLabels([free("q1"), free("a1", "assistant")])).toEqual(new Map());
  });

  it("shows none in a plain back-and-forth, though every message is in the thread", () => {
    expect(
      threadLabels([g("q1"), a("a1", "q1"), g("q2", "q1"), a("a2", "q1"), a("a3", "q1")]),
    ).toEqual(new Map());
  });

  it("shows none for a thread of one message, or one whose other messages are not loaded", () => {
    expect(threadLabels([g("q1"), free("w1"), a("a1", "q9"), free("w2", "assistant")])).toEqual(
      new Map(),
    );
  });

  it("labels every agent message in a thread another message splits, and none of the guardian's", () => {
    expect(
      where(threadLabels([g("q1"), a("a1", "q1"), g("q2", "q1"), free("w1"), a("a2", "q1")])),
    ).toEqual([
      ["a1", "q1"],
      ["a2", "q1"],
    ]);
  });

  it("splits a thread by an agent message in none or in another thread too, but not by a trace", () => {
    const trace: ThreadTimelineMessage = { id: "tr", role: "trace", chatThreadId: null };
    expect(where(threadLabels([g("q1"), a("a1", "q1"), trace, a("a2", "q1")]))).toEqual([]);
    expect(
      where(threadLabels([g("q1"), a("a1", "q1"), free("w1", "assistant"), a("a2", "q1")])),
    ).toEqual([
      ["a1", "q1"],
      ["a2", "q1"],
    ]);
    expect(
      where(
        threadLabels([
          g("q1"),
          a("a1", "q1"),
          g("q2"),
          a("b1", "q2"),
          a("a2", "q1"),
          a("b2", "q2"),
        ]),
      ),
    ).toEqual([
      ["a1", "q1"],
      ["b1", "q2"],
      ["a2", "q1"],
      ["b2", "q2"],
    ]);
  });

  it("labels every agent message in a split thread alike: plain text, a forward and a card", () => {
    const withParts = (id: string, parts: unknown[]): ThreadTimelineMessage => ({
      ...a(id, "q1"),
      content: JSON.stringify(parts),
    });
    const messages = [
      g("q1"),
      free("w0"),
      withParts("forward", [
        { type: "text", content: "Here it is" },
        { type: "text", content: "# Report", forwardedFrom: { chatId: "c1", title: "Flights" } },
      ]),
      free("w1", "assistant"),
      withParts("card", [{ type: "task_chat", chatId: "c1", title: "Flights", show: "ask" }]),
      free("w2", "assistant"),
      withParts("said", [{ type: "text", content: "Two options so far." }]),
    ];
    // One label per message, each opening the thread.
    expect(where(threadLabels(messages))).toEqual([
      ["forward", "q1"],
      ["card", "q1"],
      ["said", "q1"],
    ]);
  });

  it("labels the only message of a run", () => {
    expect(where(threadLabels([g("q1"), free("w1"), a("a1", "q1")]))).toEqual([["a1", "q1"]]);
  });

  it("labels both messages of a run of two", () => {
    expect(where(threadLabels([g("q1"), free("w1"), a("a1", "q1"), a("a2", "q1")]))).toEqual([
      ["a1", "q1"],
      ["a2", "q1"],
    ]);
  });

  it("labels only the first and the last of a run of three or more", () => {
    const run = [a("a1", "q1"), a("a2", "q1"), a("a3", "q1"), a("a4", "q1")];
    expect(where(threadLabels([g("q1"), free("w1"), ...run]))).toEqual([
      ["a1", "q1"],
      ["a4", "q1"],
    ]);
  });

  it("keeps a run through the owner's messages: they neither end nor join it", () => {
    const labels = threadLabels([
      g("q1"),
      a("a1", "q1"),
      g("x1", "q1"),
      a("a2", "q1"),
      free("w1"),
      a("a3", "q1"),
    ]);
    expect(where(labels)).toEqual([
      ["a1", "q1"],
      ["a3", "q1"],
    ]);
  });

  it("ends a run at another thread's message or an agent message in no thread", () => {
    const labels = threadLabels([
      g("q1"),
      a("a1", "q1"),
      a("a2", "q1"),
      a("b1", "q2"),
      a("a3", "q1"),
      a("a4", "q1"),
      free("w0", "assistant"),
      a("a5", "q1"),
      a("a6", "q1"),
      free("w1", "assistant"),
      a("a7", "q1"),
      a("a8", "q1"),
      a("a9", "q1"),
    ]);
    // Every run here is of one or two, but the last. Thread q2 holds b1 alone.
    expect(where(labels)).toEqual([
      ["a1", "q1"],
      ["a2", "q1"],
      ["a3", "q1"],
      ["a4", "q1"],
      ["a5", "q1"],
      ["a6", "q1"],
      ["a7", "q1"],
      ["a9", "q1"],
    ]);
  });

  it("labels no task card, the one shown when its task starts: it names its task itself", () => {
    const card = (id: string, show?: "task" | "ask"): ThreadTimelineMessage => ({
      ...a(id, "q1"),
      content: JSON.stringify([{ type: "task_chat", chatId: "c1", title: "Flights", show }]),
    });
    expect(
      where(
        threadLabels([g("q1"), free("w1"), card("start", "task"), card("old"), card("ask", "ask")]),
      ),
    ).toEqual([["ask", "q1"]]);
  });

  it("names a thread by the title its messages carry", () => {
    const labels = threadLabels([
      g("q1"),
      free("w1"),
      { ...a("a1", "q1"), chatThreadTitle: "Tokyo weather" },
    ]);
    expect(labels.get("a1")).toEqual({ thread: "q1", title: "Tokyo weather" });
  });

  it("shows no label in a split thread that has no name", () => {
    expect(threadLabels([g("q7"), free("w1"), a("a1", "q7")])).toEqual(new Map());
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

// The root arrived before its reply, so the server sent it no thread. A message
// of no thread between the replies splits the thread, so it shows labels.
const messages = [
  {
    ...message("m1", "user", "Plan Kyoto in April", "", 0),
    chatThreadId: null,
  },
  {
    ...message("a1", "assistant", "Hotels first, then the days.", "m1", 1),
    chatThreadTitle: "Kyoto trip",
  },
  { ...message("f1", "user", "What is the weather?", "", 1), chatThreadId: null },
  message("m2", "user", "Which one is closest?", "m1", 2),
  { ...message("a2", "assistant", "The river one.", "m1", 3), chatThreadTitle: "Kyoto trip" },
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

/** `focused` is the thread in focus: a message of it, its name and its root. */
function renderTranscript(
  shown: ChatMessage[] = messages,
  focused?: { thread: string; title: string; root: string },
  selection?: ComponentProps<typeof ConciergeTranscript>["selection"],
) {
  const box: { thread: string | null } = { thread: null };
  const rows = buildRows(shown, new Map(), idle.identity, {
    runningTurnId: null,
    isStreaming: false,
  });
  function Chat() {
    const draft = useReplyDraftState({
      chatId: "concierge",
      sessionId: "concierge",
      messageIds: new Set(shown.map((m) => m.id)),
      jump: () => {},
      focusComposer: () => {},
      onOpenThread: (next) => {
        box.thread = next.thread;
      },
      thread: focused ?? null,
    });
    return (
      <MemoryRouter>
        <ReplyDraftProvider value={draft}>
          <ThemeProvider>
            <ChatThreadsProvider value={chatThreadsOf(shown, focused?.root ?? null)}>
              <ReplyBar />
              <ConciergeTranscript
                rows={rows}
                live={idle}
                actions={actions}
                contentRef={() => {}}
                selection={selection}
              />
            </ChatThreadsProvider>
          </ThemeProvider>
        </ReplyDraftProvider>
      </MemoryRouter>
    );
  }
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <Chat />
    </QueryClientProvider>,
  );
  return () => box.thread;
}

describe("the thread label in the transcript", () => {
  it("sits under each of the agent's messages in the thread, names its task, and opens it", () => {
    const thread = renderTranscript();
    const labels = screen.getAllByRole("button", { name: "Kyoto trip" });
    expect(labels).toHaveLength(2);
    expect(labels[0]?.getAttribute("title")).toBe("Kyoto trip");
    // The focus is held on the message whose label was clicked.
    fireEvent.click(labels[1]!);
    expect(thread()).toBe("a2");
  });

  it("sits under a forwarded result too, below its bubble, with no header inside it", () => {
    const forward = {
      ...message("a3", "assistant", "", "m1", 4),
      content: JSON.stringify([
        {
          type: "text",
          content: "Ryokan by the river, 3 nights.",
          forwardedFrom: { chatId: "task-1", title: "Kyoto trip" },
        },
      ]),
    } as ChatMessage;
    renderTranscript([...messages, forward]);
    // The run's first and last: the owner's message between them ends nothing.
    const labels = screen.getAllByRole("button", { name: "Kyoto trip" });
    expect(labels).toHaveLength(2);
    const bubble = screen.getByText("Ryokan by the river, 3 nights.");
    // No task header inside the bubble: the label below names the task.
    expect(bubble.closest("[data-concierge-bubble-part]")?.querySelector("a")).toBeNull();
    const last = labels.at(-1)!;
    expect(last.previousElementSibling?.contains(bubble)).toBe(true);
  });

  it("cuts a long title at a fixed width, whole in its tooltip and accessible name", () => {
    const title = "Compare every ryokan along the Kamo river for the April trip";
    renderTranscript(
      messages.map((message) =>
        message.chatThreadId ? { ...message, chatThreadTitle: title } : message,
      ),
    );
    const [label] = screen.getAllByRole("button", { name: title });
    expect(label!.getAttribute("title")).toBe(title);
    expect(label!.lastElementChild?.className).toContain("max-w-56");
    expect(label!.lastElementChild?.className).toContain("truncate");
    // Regular weight, not the badge's.
    expect(label!.className).toContain("text-aux");
    expect(label!.className).not.toContain("text-badge");
  });

  it("draws iOS's thin turn-down arrow before the title, keeps its look on hover, and shows a pointer", () => {
    renderTranscript();
    const [label] = screen.getAllByRole("button", { name: "Kyoto trip" });
    const arrow = label!.firstElementChild;
    expect(arrow?.tagName.toLowerCase()).toBe("svg");
    expect(arrow?.getAttribute("aria-hidden")).toBe("true");
    expect(arrow?.getAttribute("stroke-width")).toBe("1.5");
    expect(label!.textContent).not.toContain("↳");
    const classes = label!.className.split(/\s+/);
    expect(classes).toEqual(expect.arrayContaining(["cursor-pointer", "text-muted-foreground/75"]));
    expect(classes.some((name) => name.startsWith("hover:"))).toBe(false);
    // Keyboard focus still shows.
    expect(classes).toContain("focus-visible:outline-solid");
  });

  it("offers no Reply on a card, and its label focuses the thread", () => {
    const card = {
      ...message("c1", "assistant", "", "m1", 4),
      content: JSON.stringify([
        { type: "task_chat", chatId: "task-1", title: "Kyoto trip", show: "ask" },
      ]),
    } as ChatMessage;
    const thread = renderTranscript([...messages, card]);
    // Each bubble's details hold its actions.
    const actionsOf = (id: string) => {
      const bubble = document.querySelector<HTMLElement>(`[data-timeline-anchor="${id}"]`)!;
      fireEvent.click(within(bubble).getByRole("button", { name: "Message details" }));
      return bubble;
    };
    expect(within(actionsOf("c1")).queryByRole("button", { name: "Reply" })).toBeNull();
    // A message with text still takes one.
    expect(within(actionsOf("a2")).getByRole("button", { name: "Reply" })).toBeTruthy();

    fireEvent.click(screen.getAllByRole("button", { name: "Kyoto trip" }).at(-1)!);
    expect(thread()).toBe("c1");
    // A focus quotes nothing: the reply bar stays closed.
    expect(document.querySelector("[data-reply-bar]")).toBeNull();
  });

  it("sits under none of the guardian's messages", () => {
    renderTranscript();
    const labelled = screen
      .getAllByRole("button", { name: "Kyoto trip" })
      .map((label) => label.previousElementSibling?.textContent ?? "");
    expect(labelled.some((text) => text.includes("Plan Kyoto in April"))).toBe(false);
    expect(labelled.some((text) => text.includes("Which one is closest?"))).toBe(false);
  });

  it("reads as pressed while its thread is in focus, and not before", () => {
    renderTranscript();
    for (const label of screen.getAllByRole("button", { name: "Kyoto trip" })) {
      expect(label.getAttribute("aria-pressed")).toBe("false");
    }
    cleanup();
    renderTranscript(messages, { thread: "a2", title: "Kyoto trip", root: "m1" });
    for (const label of screen.getAllByRole("button", { name: "Kyoto trip" })) {
      expect(label.getAttribute("aria-pressed")).toBe("true");
      expect(label.className).toContain("aria-pressed:text-muted-foreground");
    }
  });

  it("is the way in from the transcript: a tap on a message opens nothing", () => {
    const thread = renderTranscript();
    fireEvent.click(screen.getByText("Hotels first, then the days."));
    expect(thread()).toBeNull();
  });
});

describe("the source label in the transcript", () => {
  /** The trace of turn `turnId`, which ran on input from `source`. */
  const trace = (
    turnId: string,
    minute: number,
    source: { type: "routine" | "agent"; name: string },
  ) =>
    ({
      id: `trace-${turnId}`,
      sessionId: "concierge",
      turnId,
      role: "trace",
      content: "[]",
      createdAt: at(minute),
      traceSummary: {
        distinctApps: [],
        invocationCounts: {},
        totalSteps: 0,
        automatedInput: source,
      },
    }) as ChatMessage;
  const reply = (id: string, minute: number, chatThreadId: string | null = null) =>
    ({
      ...message(id, "assistant", `said ${id}`, chatThreadId ?? "", minute),
      chatThreadId,
    }) as ChatMessage;

  it("sits under the Concierge's reply to a routine, names it, and opens nothing", () => {
    renderTranscript([
      trace("t-r1", 10, { type: "routine", name: "Daily summary" }),
      reply("r1", 10),
    ]);
    const label = screen.getByText("Routine · Daily summary");
    expect(label.closest("button")).toBeNull();
    // Plain text: no arrow, unlike a thread label.
    expect(label.closest("[data-source-label]")?.querySelector("svg")).toBeNull();
    expect(label.closest("[data-source-label]")?.getAttribute("data-source-label")).toBe("routine");
    expect(screen.queryByRole("note")).toBeNull();
  });

  it("shows nothing for an agent's input the Concierge did not answer", () => {
    renderTranscript([trace("t-x", 10, { type: "agent", name: "Flint" })]);
    expect(screen.queryByText(/Flint/)).toBeNull();
  });

  it("gives the middle of a thread's run no label, its source's neither", () => {
    renderTranscript([
      ...messages,
      trace("t-a3", 12, { type: "routine", name: "Check-in" }),
      reply("a3", 12, "m1"),
      reply("a4", 12, "m1"),
    ]);
    // a1 to a4 run on, the owner's m2 between them included: a2 and a3 show nothing.
    expect(screen.getAllByRole("button", { name: "Kyoto trip" })).toHaveLength(2);
    expect(screen.queryByText("Routine · Check-in")).toBeNull();
  });

  it("keeps a routine reply's source label when the owner replies to it: that thread shows no labels", () => {
    renderTranscript([
      trace("t-r1", 10, { type: "routine", name: "Daily summary" }),
      reply("r1", 10),
      message("g1", "user", "thanks", "r1", 11),
    ]);
    expect(screen.getByText("Routine · Daily summary")).toBeTruthy();
    expect(document.querySelector("[data-thread-label]")).toBeNull();
  });

  it("gives a reply in a task's thread its thread label alone", () => {
    renderTranscript([
      ...messages,
      trace("t-a3", 12, { type: "routine", name: "Check-in" }),
      reply("a3", 12, "m1"),
    ]);
    expect(screen.getAllByRole("button", { name: "Kyoto trip" })).toHaveLength(2);
    expect(screen.queryByText("Routine · Check-in")).toBeNull();
  });
});

describe("the transcript with a thread in focus", () => {
  // Two threads and a message in none, over two stretches of the day.
  const other = (
    id: string,
    role: "user" | "assistant",
    chatThreadId: string | null,
    minute: number,
  ) =>
    ({
      ...message(id, role, `said ${id}`, chatThreadId ?? "", minute),
      chatThreadId,
    }) as ChatMessage;
  const day = [
    ...messages,
    // Said right after a2, so they share its group.
    other("nx", "assistant", "n1", 4),
    { ...other("n1", "user", "n1", 5), chatThreadTitle: "Flights" },
    other("n2", "assistant", "n1", 6),
    other("free1", "assistant", null, 7),
    // A later stretch with nothing of the Kyoto thread in it.
    other("n3", "assistant", "n1", 40),
  ];
  const marked = () =>
    [...document.querySelectorAll<HTMLElement>("[data-thread-out]")].map(
      (element) => element.dataset.threadEntry ?? element.tagName.toLowerCase(),
    );
  const entry = (id: string) => document.querySelector<HTMLElement>(`[data-thread-entry="${id}"]`)!;
  const focusKyoto = { thread: "a2", title: "Kyoto trip", root: "m1" };

  it("marks nothing without a focus", () => {
    renderTranscript(day);
    expect(marked()).toEqual([]);
    expect(entry("n2")).toBeTruthy();
  });

  it("marks the messages of other threads and of none, and keeps the thread's, the guardian's among them", () => {
    renderTranscript(day, focusKyoto);
    const out = (id: string) => entry(id).closest("[data-thread-out]") !== null;
    // The thread: m1 and m2 (the guardian's), a1 and a2.
    expect(["m1", "a1", "m2", "a2"].map(out)).toEqual([false, false, false, false]);
    // The other thread's, the guardian's included, and the message in none.
    expect(["nx", "n1", "n2", "free1", "n3"].map(out)).toEqual([true, true, true, true, true]);
  });

  it("folds a group whose messages are all hidden whole, and a mixed one message by message", () => {
    renderTranscript(day, focusKyoto);
    // n2 and free1 share a group, and n3 stands alone in one: each folds whole.
    for (const id of ["n2", "n3"]) {
      expect(entry(id).parentElement?.hasAttribute("data-thread-out")).toBe(true);
      expect(entry(id).hasAttribute("data-thread-out")).toBe(false);
    }
    // a2's group also holds nx: only nx folds.
    expect(entry("a2").parentElement?.hasAttribute("data-thread-out")).toBe(false);
    expect(entry("nx").hasAttribute("data-thread-out")).toBe(true);
  });

  it("folds the time line with nothing of the thread under it, and keeps the other", () => {
    renderTranscript(day, focusKyoto);
    const lines = [...document.querySelectorAll<HTMLElement>("time")].map(
      (time) => time.parentElement!,
    );
    expect(lines).toHaveLength(2);
    expect(lines.map((line) => line.hasAttribute("data-thread-out"))).toEqual([false, true]);
  });

  it("keeps a group of the thread and its label as they are, with the label pressed", () => {
    renderTranscript(day, focusKyoto);
    const label = screen.getAllByRole("button", { name: "Kyoto trip" })[0]!;
    expect(label.closest("[data-thread-out]")).toBeNull();
    expect(label.getAttribute("aria-pressed")).toBe("true");
    // The other thread's label is folded away with its message.
    expect(
      screen.getAllByRole("button", { name: "Flights" })[0]!.closest("[data-thread-out]"),
    ).toBeTruthy();
  });

  it("hides nothing while share selection runs, so a turn of messages in several threads shows whole", () => {
    // One turn holds a Kyoto message and a Flights one.
    const mixed = [
      ...messages,
      {
        ...message("ax", "assistant", "said ax", "n1", 4),
        turnId: "t-a2",
        chatThreadTitle: "Flights",
      } as ChatMessage,
    ];
    const selection = {
      selectedTurns: new Set(["t-a2"]),
      selectableSessionId: "concierge",
      onToggleTurn: () => {},
    };
    renderTranscript(mixed, focusKyoto, selection);

    expect(marked()).toEqual([]);
    expect(entry("ax").closest("[data-thread-out]")).toBeNull();
    // The labels stay reachable under the overlay: they focus nothing here.
    cleanup();

    // Without the selection the same focus hides the Flights message.
    renderTranscript(mixed, focusKyoto);
    expect(entry("ax").closest("[data-thread-out]")).not.toBeNull();
  });
});
