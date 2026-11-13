// @rstest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
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
  placed,
  placeLive,
  type ThreadPlacement,
  type ThreadTimelineMessage,
  taskThreads,
  threadLabels,
} from "./reply/chat-threads";
import { ReplyBar } from "./reply/ReplyBar";
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

  it("labels every agent message in a task's thread alike: plain text, a forward and a card", () => {
    const withParts = (id: string, parts: unknown[]): ThreadTimelineMessage => ({
      ...a(id, "q1"),
      content: JSON.stringify(parts),
    });
    const messages = [
      g("q1"),
      withParts("forward", [
        { type: "text", content: "Here it is" },
        { type: "text", content: "# Report", forwardedFrom: { chatId: "c1", title: "Flights" } },
      ]),
      g("x1", "q1"),
      withParts("card", [{ type: "task_chat", chatId: "c1", title: "Flights", show: "ask" }]),
      g("x2", "q1"),
      withParts("said", [{ type: "text", content: "Two options so far." }]),
    ];
    // One label per message, each opening the thread.
    expect(where(threadLabels(messages, tasks))).toEqual([
      ["forward", "q1"],
      ["card", "q1"],
      ["said", "q1"],
    ]);
  });

  it("labels the only message of a run", () => {
    expect(where(threadLabels([g("q1"), a("a1", "q1")], tasks))).toEqual([["a1", "q1"]]);
  });

  it("labels both messages of a run of two", () => {
    expect(where(threadLabels([g("q1"), a("a1", "q1"), a("a2", "q1")], tasks))).toEqual([
      ["a1", "q1"],
      ["a2", "q1"],
    ]);
  });

  it("labels only the first and the last of a run of three or more", () => {
    const run = [a("a1", "q1"), a("a2", "q1"), a("a3", "q1"), a("a4", "q1")];
    expect(where(threadLabels([g("q1"), ...run], tasks))).toEqual([
      ["a1", "q1"],
      ["a4", "q1"],
    ]);
  });

  it("ends a run at another thread's message, the owner's, or one in no thread", () => {
    const labels = threadLabels(
      [
        g("q1"),
        a("a1", "q1"),
        a("a2", "q1"),
        a("b1", "q2"),
        a("a3", "q1"),
        a("a4", "q1"),
        g("x1", "q1"),
        a("a5", "q1"),
        a("a6", "q1"),
        free("w1", "assistant"),
        a("a7", "q1"),
        a("a8", "q1"),
        a("a9", "q1"),
      ],
      tasks,
    );
    // Every run here is of one or two, but the last.
    expect(where(labels)).toEqual([
      ["a1", "q1"],
      ["a2", "q1"],
      ["b1", "q2"],
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
      where(threadLabels([g("q1"), card("start", "task"), card("old"), card("ask", "ask")], tasks)),
    ).toEqual([["ask", "q1"]]);
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

function renderTranscript(shown: ChatMessage[] = messages) {
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
      threads: true,
    });
    box.thread = draft.thread;
    return (
      <MemoryRouter>
        <ReplyDraftProvider value={draft}>
          <ThemeProvider>
            <ChatThreadsProvider
              value={{
                labels: threadLabels(shown),
                taskThreads: taskThreads(shown).threads,
                titles: taskThreads(shown).titles,
              }}
            >
              <ReplyBar />
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
    // The thread view loads a thread named by any of its messages.
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
    const labels = screen.getAllByRole("button", { name: "Kyoto trip" });
    expect(labels).toHaveLength(3);
    const bubble = screen.getByText("Ryokan by the river, 3 nights.");
    // No task header inside the bubble: the label below names the task.
    expect(bubble.closest("[data-concierge-bubble-part]")?.querySelector("a")).toBeNull();
    const last = labels.at(-1)!;
    expect(last.previousElementSibling?.contains(bubble)).toBe(true);
  });

  it("cuts a long title at a fixed width, whole in its tooltip and accessible name", () => {
    const title = "Compare every ryokan along the Kamo river for the April trip";
    renderTranscript([{ ...messages[0]!, chatThreadTitle: title }, messages[1]!]);
    const label = screen.getByRole("button", { name: title });
    expect(label.getAttribute("title")).toBe(title);
    expect(label.lastElementChild?.className).toContain("max-w-56");
    expect(label.lastElementChild?.className).toContain("truncate");
    // Regular weight, not the badge's.
    expect(label.className).toContain("text-aux");
    expect(label.className).not.toContain("text-badge");
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

  it("offers no Reply on a card, and its label opens the thread with a reply to it", () => {
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
    expect(document.querySelector("[data-reply-bar]")?.textContent).toBe("Reply to Kyoto trip");
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
    // a2, a3 and a4 run on with nothing between: a3 shows nothing.
    expect(screen.getAllByRole("button", { name: "Kyoto trip" })).toHaveLength(3);
    expect(screen.queryByText("Routine · Check-in")).toBeNull();
  });

  it("gives a reply in a task's thread its thread label alone", () => {
    renderTranscript([
      ...messages,
      trace("t-a3", 12, { type: "routine", name: "Check-in" }),
      reply("a3", 12, "m1"),
    ]);
    expect(screen.getAllByRole("button", { name: "Kyoto trip" })).toHaveLength(3);
    expect(screen.queryByText("Routine · Check-in")).toBeNull();
  });
});
