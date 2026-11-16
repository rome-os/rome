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
  threadsOf,
  threadTail,
} from "./reply/chat-threads";
import { ReplyBar } from "./reply/ReplyBar";
import { ReplyDraftProvider, useReplyDraftState } from "./reply/reply-draft";

// The quote in a reply, the owner's or the agent's, in a Concierge chat's
// transcript: where it shows and that it focuses the chat on the reply's
// thread. A tap on a message itself opens nothing. With a thread in focus, the
// transcript marks what is outside it.

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

  it("knows the guardian's messages in a thread too", () => {
    expect([...threadsOf([g("q1"), g("r1", "q1"), free("w1")]).roots]).toEqual([
      ["q1", "q1"],
      ["r1", "q1"],
    ]);
  });
});

describe("threadTail", () => {
  const said = (
    id: string,
    role: "user" | "assistant",
    text: string,
    chatThreadId: string,
  ): ChatMessage =>
    ({
      id,
      sessionId: "concierge",
      turnId: null,
      role,
      content: JSON.stringify([{ type: "text", content: text }]),
      createdAt: "2026-11-09T09:00:00.000Z",
      chatThreadId,
    }) as ChatMessage;

  it("quotes the last message of the thread that has text, as a focused composer replies to it", () => {
    const messages = [
      said("m1", "user", "Plan Kyoto", "m1"),
      said("a1", "assistant", "Hotels first", "m1"),
      said("x1", "assistant", "Elsewhere", "x1"),
    ];
    const { roots } = threadsOf(messages);
    expect(threadTail(messages, roots, "m1")).toEqual({
      messageId: "a1",
      author: "agent",
      preview: "Hotels first",
    });
    expect(threadTail(messages, roots, "nothing")).toBeNull();
  });

  it("passes over a card at the end of the thread, which has no text of its own to quote", () => {
    const card = {
      ...said("c1", "assistant", "", "m1"),
      content: JSON.stringify([{ type: "task_chat", chatId: "t1", title: "Flights", show: "ask" }]),
    } as ChatMessage;
    const messages = [
      said("m1", "user", "Plan Kyoto", "m1"),
      said("a1", "assistant", "Hotels", "m1"),
      card,
    ];
    const { roots } = threadsOf(messages);
    expect(threadTail(messages, roots, "m1")).toMatchObject({ messageId: "a1" });
    expect(threadTail([card], threadsOf([card]).roots, "m1")).toBeNull();
  });
});

const at = (minute: number) => new Date(2026, 10, 9, 9, minute).toISOString();
/** The quote a reply carries: the message it replies to and what it said. */
type Quote = { messageId: string; author: "guardian" | "agent"; text: string };
const message = (
  id: string,
  role: "user" | "assistant",
  text: string,
  chatThreadId: string,
  minute: number,
  quote?: Quote,
): ChatMessage =>
  ({
    id,
    sessionId: "concierge",
    turnId: role === "assistant" ? `t-${id}` : null,
    role,
    content: JSON.stringify([
      ...(quote ? [{ type: "reply_to", ...quote }] : []),
      { type: "text", content: text },
    ]),
    createdAt: at(minute),
    chatThreadId,
  }) as ChatMessage;

// A thread of Kyoto: the owner's question, the Concierge's answer, and the
// owner's reply to it, each carrying the quote of what it replies to. A message
// of another thread between the replies splits it up.
const messages = [
  message("m1", "user", "Plan Kyoto in April", "m1", 0),
  {
    ...message("a1", "assistant", "Hotels first, then the days.", "m1", 1, {
      messageId: "m1",
      author: "guardian",
      text: "Plan Kyoto in April",
    }),
    chatThreadTitle: "Kyoto trip",
  },
  message("f1", "user", "What is the weather?", "f1", 1),
  message("m2", "user", "Which one is closest?", "m1", 2, {
    messageId: "a1",
    author: "agent",
    text: "Hotels first, then the days.",
  }),
  {
    ...message("a2", "assistant", "The river one.", "m1", 3, {
      messageId: "m2",
      author: "guardian",
      text: "Which one is closest?",
    }),
    chatThreadTitle: "Kyoto trip",
  },
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
  const box: { thread: string | null; jumps: string[] } = { thread: null, jumps: [] };
  const rows = buildRows(shown, new Map(), idle.identity, {
    runningTurnId: null,
    isStreaming: false,
  });
  function Chat() {
    const draft = useReplyDraftState({
      chatId: "concierge",
      sessionId: "concierge",
      messageIds: new Set(shown.map((m) => m.id)),
      jump: (id) => {
        box.jumps.push(id);
      },
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
  return Object.assign(() => box.thread, { jumps: box.jumps });
}

/** The quote buttons in the transcript, in order: each is the quote of one reply. */
const quotes = () => [...document.querySelectorAll<HTMLElement>("[data-reply-quote]")];
/** The quote in the bubble of message `id`. */
const quoteIn = (id: string) =>
  document
    .querySelector<HTMLElement>(`[data-timeline-anchor~="${id}"]`)!
    .querySelector<HTMLElement>("[data-reply-quote]")!;

describe("the quote in a reply", () => {
  it("shows a reply that is not under what it answers with one line of the quote, in its bubble", () => {
    renderTranscript();
    // m2 replies to a1, with f1 between them.
    expect(within(quoteIn("m2")).getByText("Hotels first, then the days.")).toBeTruthy();
    const anchor = document.querySelector<HTMLElement>('[data-timeline-anchor~="m2"]')!;
    expect(within(anchor).getByText("Which one is closest?")).toBeTruthy();
    expect(anchor.contains(quoteIn("m2"))).toBe(true);
    expect(quoteIn("m2").querySelector(".rome-reply-hook")).toBeNull();
    // The root and a message that replies to nothing carry no mark.
    expect(
      document.querySelector('[data-timeline-anchor~="m1"]')?.querySelector("[data-reply-quote]"),
    ).toBeNull();
    expect(
      document.querySelector('[data-timeline-anchor~="f1"]')?.querySelector("[data-reply-quote]"),
    ).toBeNull();
  });

  it("quotes a task card that replies, as a bubble does, in the words the quote stores", () => {
    const card = (id: string, minute: number, quote: Quote): ChatMessage =>
      ({
        ...message(id, "assistant", "", "m1", minute),
        content: JSON.stringify([
          { type: "reply_to", ...quote },
          { type: "task_chat", chatId: "t1", title: "Flights", show: "task" },
        ]),
      }) as ChatMessage;
    // One card right under its request, and one with another message between.
    const near = card("c1", 1, {
      messageId: "m1",
      author: "guardian",
      text: "Plan Kyoto in April",
    });
    const far = card("c2", 3, { messageId: "m1", author: "guardian", text: "Plan Kyoto in April" });
    renderTranscript([messages[0]!, near, messages[2]!, far]);
    expect(quoteIn("c1").querySelector(".rome-reply-hook")).not.toBeNull();
    expect(quoteIn("c1").getAttribute("aria-label")).toBe("Plan Kyoto in April");
    expect(within(quoteIn("c2")).getByText("Plan Kyoto in April")).toBeTruthy();
    expect(quoteIn("c2").querySelector(".rome-reply-hook")).toBeNull();
  });

  it("marks a reply under what it answers with a hook, the quoted text its name, and draws no text", () => {
    renderTranscript();
    // a1 answers m1, right above it, and a2 answers m2, right above it.
    for (const [id, quoted] of [
      ["a1", "Plan Kyoto in April"],
      ["a2", "Which one is closest?"],
    ] as const) {
      const mark = quoteIn(id);
      expect(mark.getAttribute("aria-label")).toBe(quoted);
      expect(mark.getAttribute("title")).toBe(quoted);
      expect(mark.querySelector(".rome-reply-hook")).not.toBeNull();
      expect(within(mark).queryByText(quoted)).toBeNull();
    }
    expect(quotes()).toHaveLength(3);
    // The guardian's hook stands on the guardian's side.
    expect(quoteIn("a1").dataset.side).toBe("start");
    cleanup();
    renderTranscript([
      ...messages,
      message("m3", "user", "Thanks", "m1", 4, {
        messageId: "a2",
        author: "agent",
        text: "The river one.",
      }),
    ]);
    expect(quoteIn("m3").dataset.side).toBe("end");
    expect(quoteIn("m3").querySelector(".rome-reply-hook")).not.toBeNull();
  });

  it("joins sibling replies with a line, the first with a hook, on one side and the other", () => {
    const sibling = (id: string, minute: number) =>
      message(id, "assistant", `said ${id}`, "m1", minute, {
        messageId: "m1",
        author: "guardian",
        text: "Plan Kyoto in April",
      });
    renderTranscript([messages[0]!, sibling("s1", 1), sibling("s2", 1), sibling("s3", 1)]);
    expect(quoteIn("s1").querySelector(".rome-reply-hook")).not.toBeNull();
    for (const id of ["s2", "s3"]) {
      const mark = quoteIn(id);
      expect(mark.querySelector(".rome-reply-line")).not.toBeNull();
      expect(mark.querySelector(".rome-reply-hook")).toBeNull();
      // The line spans the gap between the bubbles of a group.
      expect(mark.style.height).toBe("8px");
    }
  });

  it("focuses the thread of the reply that holds it, whoever said it, held on that reply", () => {
    const thread = renderTranscript();
    fireEvent.click(quoteIn("a2"));
    expect(thread()).toBe("a2");
    fireEvent.click(quoteIn("m2"));
    expect(thread()).toBe("m2");
  });

  it("names no task under any message", () => {
    renderTranscript();
    expect(screen.queryByRole("button", { name: "Kyoto trip" })).toBeNull();
    expect(document.querySelector("[data-thread-label]")).toBeNull();
  });

  it("sits in the first bubble of a forwarded result, above the report, with no header inside it", () => {
    const forward = {
      ...message("a3", "assistant", "", "m1", 4, {
        messageId: "m1",
        author: "guardian",
        text: "Plan Kyoto in April",
      }),
      content: JSON.stringify([
        { type: "reply_to", messageId: "m1", author: "guardian", text: "Plan Kyoto in April" },
        { type: "text", content: "Here it is" },
        {
          type: "text",
          content: "Ryokan by the river, 3 nights.",
          forwardedFrom: { chatId: "task-1", title: "Kyoto trip" },
        },
      ]),
    } as ChatMessage;
    renderTranscript([...messages, forward]);
    const entry = document.querySelector<HTMLElement>('[data-thread-entry="a3"]')!;
    // One quote for the message, in its first bubble.
    expect(entry.querySelectorAll("[data-reply-quote]")).toHaveLength(1);
    const first = screen.getByText("Here it is").closest("[data-concierge-bubble]")!;
    expect(first.contains(entry.querySelector("[data-reply-quote]"))).toBe(true);
    const report = screen.getByText("Ryokan by the river, 3 nights.");
    expect(report.closest("[data-concierge-bubble-part]")?.querySelector("a")).toBeNull();
  });

  it("sits above a task's card, which takes no Reply", () => {
    const card = {
      ...message("c1", "assistant", "", "m1", 4),
      content: JSON.stringify([
        { type: "reply_to", messageId: "m1", author: "guardian", text: "Plan Kyoto in April" },
        { type: "task_chat", chatId: "task-1", title: "Kyoto trip", show: "ask" },
      ]),
    } as ChatMessage;
    const thread = renderTranscript([...messages, card]);
    const anchor = document.querySelector<HTMLElement>('[data-timeline-anchor~="c1"]')!;
    expect(within(anchor).getByText("Plan Kyoto in April")).toBeTruthy();
    // Each bubble's details hold its actions.
    fireEvent.click(within(anchor).getByRole("button", { name: "Message details" }));
    expect(within(anchor).queryByRole("button", { name: "Reply" })).toBeNull();
    fireEvent.click(quoteIn("c1"));
    expect(thread()).toBe("c1");
  });

  it("goes to the original while a thread is in focus and the thread shows it, and is plain text otherwise", () => {
    const thread = renderTranscript(messages, { thread: "a2", title: "Kyoto trip", root: "m1" });
    // a1's original, m1, is in the thread in focus: the quote jumps to it.
    fireEvent.click(quoteIn("a1"));
    expect(thread.jumps).toEqual(["m1"]);
    expect(thread()).toBeNull();
    cleanup();
    // The reply of another thread is hidden, so its quote cannot be pressed.
    const elsewhere = [
      ...messages,
      message("z1", "assistant", "Other", "z0", 5, {
        messageId: "z0",
        author: "guardian",
        text: "Gone",
      }),
    ];
    renderTranscript(elsewhere, { thread: "a2", title: "Kyoto trip", root: "m1" });
    const out = document.querySelector('[data-thread-entry="z1"]')!.closest("[data-thread-out]");
    expect(out).not.toBeNull();
  });

  it("is the way in from the transcript: a tap on a message opens nothing", () => {
    const thread = renderTranscript();
    fireEvent.click(
      screen.getByText("Hotels first, then the days.", { selector: "[data-concierge-bubble] p" }),
    );
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
    // Plain text, with no arrow.
    expect(label.closest("[data-source-label]")?.querySelector("svg")).toBeNull();
    expect(label.closest("[data-source-label]")?.getAttribute("data-source-label")).toBe("routine");
    expect(screen.queryByRole("note")).toBeNull();
  });

  it("shows nothing for an agent's input the Concierge did not answer", () => {
    renderTranscript([trace("t-x", 10, { type: "agent", name: "Flint" })]);
    expect(screen.queryByText(/Flint/)).toBeNull();
  });

  it("stays under a reply in a thread: a source says where the turn came from, not what thread it is in", () => {
    renderTranscript([
      ...messages,
      trace("t-a3", 12, { type: "routine", name: "Check-in" }),
      reply("a3", 12, "m1"),
    ]);
    expect(screen.getByText("Routine · Check-in")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Kyoto trip" })).toBeNull();
  });

  it("stays under a routine reply when the owner replies to it", () => {
    renderTranscript([
      trace("t-r1", 10, { type: "routine", name: "Daily summary" }),
      reply("r1", 10),
      message("g1", "user", "thanks", "r1", 11),
    ]);
    expect(screen.getByText("Routine · Daily summary")).toBeTruthy();
    expect(document.querySelector("[data-thread-label]")).toBeNull();
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
    cleanup();

    // Without the selection the same focus hides the Flights message.
    renderTranscript(mixed, focusKyoto);
    expect(entry("ax").closest("[data-thread-out]")).not.toBeNull();
  });
});
