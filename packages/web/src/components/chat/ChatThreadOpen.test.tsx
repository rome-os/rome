// @rstest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ComponentProps } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { conciergePageOf } from "@/lib/chat-api";
import { orderChatMessages } from "@/lib/chat-message-ordering";
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
  unreadIn,
} from "./reply/chat-threads";
import { ReplyBar } from "./reply/ReplyBar";
import { ThreadPills } from "./reply/ThreadPills";
import { plainQuote, quoteLine, replyPreview } from "./reply/reply-source";
import { ReplyDraftProvider, useReplyDraftState } from "./reply/reply-draft";
import { threadOfLink } from "./reply/thread-link";

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

/**
 * `focused` is the thread in focus: a message of it, its name and its root.
 * `stacking` leaves the replies of a thread out of the main timeline for its
 * stack, as the chat does with no thread in focus; without it, every message
 * shows, which is how a thread in focus and a share show them.
 */
function renderTranscript(
  shown: ChatMessage[] = messages,
  focused?: { thread: string; title: string; root: string },
  selection?: ComponentProps<typeof ConciergeTranscript>["selection"],
  stacking = false,
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
            <ChatThreadsProvider value={chatThreadsOf(shown, focused?.root ?? null, stacking)}>
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
    // The card right under its request shows no quote.
    expect(
      document.querySelector('[data-timeline-anchor~="c1"]')?.querySelector("[data-reply-quote]"),
    ).toBeNull();
    expect(within(quoteIn("c2")).getByText("Plan Kyoto in April")).toBeTruthy();
  });

  it("shows nothing extra on a reply right under what it answers: no quote and no connector", () => {
    renderTranscript([
      ...messages,
      message("m3", "user", "Thanks", "m1", 4, {
        messageId: "a2",
        author: "agent",
        text: "The river one.",
      }),
    ]);
    // a1 answers m1, a2 answers m2 and m3 answers a2, each right above it.
    for (const id of ["a1", "a2", "m3"]) {
      expect(
        document
          .querySelector(`[data-timeline-anchor~="${id}"]`)
          ?.querySelector("[data-reply-quote]"),
      ).toBeNull();
    }
    // Only m2, which has f1 between it and a1, keeps its quote.
    expect(quotes().map((quote) => quote.dataset.replyQuote)).toEqual(["a1"]);
    expect(
      document.querySelector(".rome-reply-rail, .rome-reply-hook, .rome-reply-line"),
    ).toBeNull();
  });

  it("shows nothing extra on sibling replies of one message that follow each other", () => {
    const sibling = (id: string, minute: number) =>
      message(id, "assistant", `said ${id}`, "m1", minute, {
        messageId: "m1",
        author: "guardian",
        text: "Plan Kyoto in April",
      });
    renderTranscript([messages[0]!, sibling("s1", 1), sibling("s2", 1), sibling("s3", 1)]);
    expect(quotes()).toHaveLength(0);
    expect(screen.getByText("said s3")).toBeTruthy();
  });

  it("focuses the thread of the reply that holds it, whoever said it, held on that reply", () => {
    const thread = renderTranscript();
    fireEvent.click(quoteIn("m2"));
    expect(thread()).toBe("m2");
    cleanup();
    // An agent's reply with another message between it and its request shows a quote too.
    const apart = renderTranscript([
      messages[0]!,
      messages[2]!,
      message("a9", "assistant", "Done", "m1", 3, {
        messageId: "m1",
        author: "guardian",
        text: "Plan Kyoto in April",
      }),
    ]);
    fireEvent.click(quoteIn("a9"));
    expect(apart()).toBe("a9");
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
    // a3 answers m1 with m2 between them, so it shows a quote.
    const apart = [
      ...messages,
      message("a3", "assistant", "Also", "m1", 4, {
        messageId: "m1",
        author: "guardian",
        text: "Plan Kyoto in April",
      }),
    ];
    const thread = renderTranscript(apart, { thread: "a2", title: "Kyoto trip", root: "m1" });
    // m1, its original, is in the thread in focus: the quote jumps to it.
    fireEvent.click(quoteIn("a3"));
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

  it("shows after a cold load by Concierge pages, whose trace rows come with the messages", () => {
    const wire = {
      mainLine: [{ message: reply("r1", 10), thread: null }],
      outside: [],
      traces: [trace("t-r1", 10, { type: "routine", name: "Daily summary" })],
      nextCursor: null,
    };

    renderTranscript(orderChatMessages(conciergePageOf(wire).messages));
    expect(screen.getByText("Routine · Daily summary")).toBeTruthy();
    cleanup();

    // A page without the trace rows loses the label, which is why they come.
    renderTranscript(orderChatMessages(conciergePageOf({ ...wire, traces: [] }).messages));
    expect(screen.queryByText("Routine · Daily summary")).toBeNull();
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
    other("n3", "assistant", "n1", 90),
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

/** Marks message `id` of `all` as not yet seen by the owner. */
const unseen = (all: ChatMessage[], ...ids: string[]) =>
  all.map((message) => (ids.includes(message.id) ? { ...message, read: false } : message));

describe("the main timeline", () => {
  it("leaves out the replies of a thread and keeps its root, other threads' roots and messages in none", () => {
    renderTranscript(messages, undefined, undefined, true);
    const ids = [...document.querySelectorAll<HTMLElement>("[data-thread-entry]")].map(
      (entry) => entry.dataset.threadEntry,
    );
    // a1, m2 and a2 reply in the Kyoto thread.
    expect(ids).toEqual(["m1", "f1"]);
  });

  it("shows every message with a thread in focus, and in a share", () => {
    renderTranscript(messages, { thread: "a2", title: "Kyoto trip", root: "m1" }, undefined, true);
    expect(document.querySelector('[data-thread-entry="a2"]')).not.toBeNull();
    expect(document.querySelector("[data-thread-stack]")).toBeNull();
    cleanup();
    renderTranscript(
      messages,
      undefined,
      { selectableSessionId: "concierge", selectedTurns: new Set(), onToggleTurn: () => {} },
      false,
    );
    expect(document.querySelector('[data-thread-entry="a2"]')).not.toBeNull();
    expect(document.querySelector("[data-thread-stack]")).toBeNull();
  });

  it("leaves out a reply whose root is not loaded too: a reply never draws in the main line", () => {
    renderTranscript(messages.slice(1), undefined, undefined, true);
    expect(document.querySelector('[data-thread-entry="a1"]')).toBeNull();
    expect(document.querySelector('[data-thread-entry="f1"]')).not.toBeNull();
    // No root is drawn, so there is nothing to hang a stack from.
    expect(document.querySelector("[data-thread-stack]")).toBeNull();
  });
});

describe("the stacks of loaded replies", () => {
  it("stacks every reply, whether its root is loaded or not", () => {
    const { stacks, stacked } = chatThreadsOf([
      a("a1", "q1"),
      g("q2"),
      a("a2", "q2"),
      g("a3", "q2"),
      free("w1"),
    ]);
    // q1 is not loaded: its reply stands in a stack all the same.
    expect([...stacked]).toEqual(["a1", "a2", "a3"]);
    expect([...stacks.keys()]).toEqual(["q1", "q2"]);
    expect(stacks.get("q2")).toMatchObject({ total: 2, unread: 0 });
  });

  it("counts a reply only the owner has not seen, and no automation's", () => {
    const { stacks } = chatThreadsOf([
      { ...a("a1", "q1"), read: false },
      { ...a("a2", "q1"), read: true },
      { ...a("a3", "q1"), read: false, sender: { kind: "automated" } },
    ] as ThreadTimelineMessage[]);
    expect(stacks.get("q1")).toMatchObject({ total: 2, unread: 1 });
  });

  it("names a thread whose root is not loaded by its task, else by the hint the page gave", () => {
    const waiting = [{ ...a("a1", "q9"), read: false }] as ThreadTimelineMessage[];
    const hints = new Map([["q9", "Plan the trip"]]);
    expect(chatThreadsOf(waiting, null, true, hints).titles.get("q9")).toBe("Plan the trip");
    const named = [{ ...waiting[0]!, chatThreadTitle: "Tokyo" }] as ThreadTimelineMessage[];
    expect(chatThreadsOf(named, null, true, hints).titles.get("q9")).toBe("Tokyo");
  });

  it("stacks nothing where a message shows itself, as in a share", () => {
    const { stacks, stacked } = chatThreadsOf([a("a1", "q1")], null, false);
    expect(stacks.size).toBe(0);
    expect(stacked.size).toBe(0);
  });
});

describe("a thread's stack", () => {
  const stackOf = (root: string) =>
    document.querySelector<HTMLElement>(`[data-thread-stack="${root}"]`)!;

  it("hangs in the root bubble's own box, so the bubble is its width reference, not the column that also holds the details row", () => {
    renderTranscript(messages, undefined, undefined, true);
    const anchor = document.querySelector<HTMLElement>('[data-timeline-anchor~="m1"]')!;
    const box = anchor.querySelector<HTMLElement>("[data-bubble-box]")!;
    const slot = stackOf("m1").parentElement!;
    // The box holds the bubble and the stack and nothing else in flow, so it is as wide as the bubble.
    expect(slot.parentElement).toBe(box);
    expect(box.firstElementChild?.hasAttribute("data-chat-bubble")).toBe(true);
    // The box takes the bubble's own width cap. Without it a long message leaves
    // the box wider than the capped bubble, and the stack is inset against the box.
    const cap = /min\(100%,var\(--container-2xl\)\)/.exec(
      readFileSync(resolve(import.meta.dirname, "ChatBubble.tsx"), "utf8"),
    )?.[0];
    expect(cap).toBeTruthy();
    expect(box.className).toContain(`has-[[data-thread-stack]]:max-w-[${cap}]`);
    // The outer box also holds the touch details row: the stack is not its child.
    expect(slot.parentElement).not.toBe(anchor);
    // A fixed inset each side, out of the box's flow so it never widens the bubble.
    expect(slot.className).toContain("absolute");
    expect(slot.className).toContain("inset-x-4");
    expect(slot.className).not.toMatch(/(^|\s)(w-|min-w-)/);
    expect(stackOf("m1").className).toContain("w-full");
    // The preview is cut to one line.
    expect(within(stackOf("m1")).getByText("The river one.").className).toContain("truncate");
  });

  it("gives the bubble a minimum width only when a thread hangs under it", () => {
    renderTranscript(messages, undefined, undefined, true);
    // f1 has no replies: its box holds no stack.
    const plain = document
      .querySelector<HTMLElement>('[data-timeline-anchor~="f1"]')!
      .querySelector<HTMLElement>("[data-bubble-box]")!;
    expect(plain.querySelector("[data-thread-stack-slot]")).toBeNull();
    // The rule keys on the stack's slot, and sets a width that fits an avatar, words and the count.
    const css = readFileSync(resolve(import.meta.dirname, "../../globals.css"), "utf8");
    const rule =
      /\[data-bubble-box\]:has\(> \[data-thread-stack-slot\]\) > :first-child \{([^}]*)\}/.exec(
        css,
      );
    expect(rule?.[1]).toMatch(/min-width:\s*14rem/);
  });

  it("shows the newest message of the thread on one line, and the total once all are seen", () => {
    renderTranscript(messages, undefined, undefined, true);
    expect(within(stackOf("m1")).getByText("The river one.")).toBeTruthy();
    // a1, m2 and a2 are replies: three.
    expect(within(stackOf("m1")).getByText("3 replies")).toBeTruthy();
    expect(stackOf("m1").hasAttribute("data-unread")).toBe(false);
    // Only a thread with replies has a stack.
    expect(stackOf("f1")).toBeNull();
  });

  it("counts the unread replies the owner did not say, and shows the count in place of the total", () => {
    renderTranscript(unseen(messages, "a1", "a2", "m2"), undefined, undefined, true);
    // m2 is the owner's own: it is never unread.
    expect(stackOf("m1").hasAttribute("data-unread")).toBe(true);
    expect(within(stackOf("m1")).getByText("2")).toBeTruthy();
    expect(within(stackOf("m1")).queryByText("3 replies")).toBeNull();
  });

  it("says nothing of waiting or working", () => {
    renderTranscript(unseen(messages, "a2"), undefined, undefined, true);
    expect(stackOf("m1").textContent).not.toMatch(/wait|work/i);
  });

  it("has a second layer only when the thread has two or more replies", () => {
    const one = [messages[0]!, messages[1]!];
    renderTranscript(one, undefined, undefined, true);
    expect(stackOf("m1").hasAttribute("data-layered")).toBe(false);
    expect(within(stackOf("m1")).getByText("1 reply")).toBeTruthy();
    cleanup();
    renderTranscript(messages, undefined, undefined, true);
    expect(stackOf("m1").hasAttribute("data-layered")).toBe(true);
  });

  it("opens the thread in focus when pressed", () => {
    const thread = renderTranscript(messages, undefined, undefined, true);
    fireEvent.click(stackOf("m1"));
    expect(thread()).toBe("m1");
  });

  it("stands under the root of an agent too, with a card as its newest message", () => {
    const root = message("r1", "assistant", "Found three flights", "r1", 0);
    const card = {
      ...message("c1", "assistant", "", "r1", 1),
      content: JSON.stringify([
        { type: "reply_to", messageId: "r1", author: "agent", text: "Found three flights" },
        { type: "task_chat", chatId: "t1", title: "Book the flight", show: "task" },
      ]),
    } as ChatMessage;
    renderTranscript([root, card], undefined, undefined, true);
    expect(within(stackOf("r1")).getByText("Book the flight")).toBeTruthy();
  });

  it("names a question card by its question and an approval card by its title", () => {
    const root = message("r1", "user", "Book it", "r1", 0);
    const ask = (card: unknown) =>
      ({
        ...message("c1", "assistant", "", "r1", 1),
        content: JSON.stringify([
          { type: "task_chat", chatId: "t1", title: "Flights", show: "ask", card },
        ]),
      }) as ChatMessage;
    renderTranscript(
      [root, ask({ kind: "approval", id: "p1", title: "Pay 300 USD", since: 1 })],
      undefined,
      undefined,
      true,
    );
    expect(within(stackOf("r1")).getByText("Pay 300 USD")).toBeTruthy();
    cleanup();
    renderTranscript(
      [
        root,
        ask({
          kind: "question",
          id: "q1",
          messageId: "m",
          since: 1,
          expired: false,
          render: { props: { questions: [{ question: "Window or aisle?" }] } },
        }),
      ],
      undefined,
      undefined,
      true,
    );
    expect(within(stackOf("r1")).getByText("Window or aisle?")).toBeTruthy();
  });

  it("does not move when a reply arrives: it stays under its root", () => {
    renderTranscript(messages, undefined, undefined, true);
    const before = [...document.querySelectorAll("[data-thread-entry]")].map(
      (entry) => (entry as HTMLElement).dataset.threadEntry,
    );
    cleanup();
    const arrived = [...unseen(messages), message("a3", "assistant", "More", "m1", 9)];
    renderTranscript(arrived, undefined, undefined, true);
    const after = [...document.querySelectorAll("[data-thread-entry]")].map(
      (entry) => (entry as HTMLElement).dataset.threadEntry,
    );
    expect(after).toEqual(before);
    expect(within(stackOf("m1")).getByText("More")).toBeTruthy();
  });
});

describe("the pills of threads with new replies", () => {
  const roots = (all: ChatMessage[]) => threadsOf(all).roots;

  it("lists the threads that have unread replies, the one waiting longest first", () => {
    const all = unseen(
      [
        ...messages,
        message("n1", "user", "Book a table", "n1", 5),
        message("n2", "assistant", "Which night?", "n1", 6),
        message("p1", "user", "Plan Nara", "p1", 7),
        message("p2", "assistant", "Done", "p1", 8),
      ],
      "n2",
      "a2",
    );
    const onPick = rs.fn();
    render(<ThreadPills threads={chatThreadsOf(all)} onPick={onPick} />);
    const pills = [...document.querySelectorAll<HTMLElement>("[data-thread-pill]")];
    // a2 (Kyoto) came before n2; p1 has no unread reply.
    expect(pills.map((pill) => pill.dataset.threadPill)).toEqual(["m1", "n1"]);
    expect(pills[0]!.textContent).toBe('New replies in "Kyoto trip"');
    fireEvent.click(pills[1]!);
    expect(onPick).toHaveBeenCalledWith("n1");
    expect(roots(all).get("n2")).toBe("n1");
  });

  it("has a pill for a thread whose root is not loaded, named by what the page gave", () => {
    const waiting = [
      { ...message("a9", "assistant", "Done", "q9", 6), read: false },
    ] as ChatMessage[];
    const onPick = rs.fn();
    render(
      <ThreadPills
        threads={chatThreadsOf(waiting, null, true, new Map([["q9", "Plan trip"]]))}
        onPick={onPick}
      />,
    );
    const pill = document.querySelector<HTMLElement>("[data-thread-pill]")!;
    expect(pill.dataset.threadPill).toBe("q9");
    expect(pill.textContent).toBe('New replies in "Plan trip"');
    fireEvent.click(pill);
    expect(onPick).toHaveBeenCalledWith("q9");
  });

  it("shows no row without a pill, and none with a thread in focus", () => {
    const { container, rerender } = render(
      <ThreadPills threads={chatThreadsOf(messages)} onPick={() => {}} />,
    );
    expect(container.firstChild).toBeNull();
    rerender(
      <ThreadPills threads={chatThreadsOf(unseen(messages, "a1"), "m1")} onPick={() => {}} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("is one row that scrolls sideways and never wraps", () => {
    render(<ThreadPills threads={chatThreadsOf(unseen(messages, "a1"))} onPick={() => {}} />);
    const row = document.querySelector<HTMLElement>("[data-thread-pills]")!;
    expect(row.className).toContain("overflow-x-auto");
    expect(row.className).not.toContain("flex-wrap");
    expect(document.querySelector("[data-thread-pill]")!.className).toContain("whitespace-nowrap");
  });

  it("cuts a long thread name short", () => {
    const long = unseen(
      [
        { ...messages[0]!, content: JSON.stringify([{ type: "text", content: "x" }]) },
        {
          ...message("a1", "assistant", "Hi", "m1", 1),
          chatThreadTitle: "A very long thread name indeed",
        },
      ],
      "a1",
    );
    render(<ThreadPills threads={chatThreadsOf(long)} onPick={() => {}} />);
    expect(document.querySelector("[data-thread-pill]")!.textContent).toBe(
      'New replies in "A very long…"',
    );
  });

  it("finds the unread messages of a thread, to read when it opens", () => {
    const all = unseen(messages, "a1", "a2", "f1");
    expect(unreadIn(all, roots(all), "m1")).toEqual(["a1", "a2"]);
  });
});

describe("a link to a thread in the Concierge's text", () => {
  const link = (root: string, label = "Flights") =>
    `See [${label}](#rome-thread=${root}) for the flights.`;
  const saying = (text: string) => [...messages, message("l1", "assistant", text, "l1", 9)];

  it("draws a chip named for the thread, with its live name over the link's text", () => {
    renderTranscript(saying(link("m1")), undefined, undefined, true);
    const chip = screen.getByRole("button", { name: "Open the thread: Kyoto trip" });
    expect(chip.textContent).toBe("# Kyoto trip");
    expect(document.body.textContent).not.toContain("rome-thread");
  });

  it("opens the thread in focus when pressed", () => {
    const thread = renderTranscript(saying(link("m1")), undefined, undefined, true);
    fireEvent.click(screen.getByRole("button", { name: "Open the thread: Kyoto trip" }));
    expect(thread()).toBe("m1");
  });

  it("is a plain chip, named by the link's text, for a thread the chat does not hold", () => {
    renderTranscript(saying(link("gone", "Tokyo trip")), undefined, undefined, true);
    expect(screen.getByText("# Tokyo trip")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Open the thread:/ })).toBeNull();
  });

  it("does not throw on a root that does not decode, and draws no chip", () => {
    expect(threadOfLink("#rome-thread=%FF")).toBeNull();
    expect(threadOfLink("#rome-thread=m1")).toBe("m1");
    expect(threadOfLink("#elsewhere")).toBeNull();
    expect(() =>
      renderTranscript(saying(link("%FF", "Broken")), undefined, undefined, true),
    ).not.toThrow();
    expect(screen.queryByText("# Broken")).toBeNull();
    expect(screen.getByText("Broken")).toBeTruthy();
  });

  it("is plain while a thread is in focus", () => {
    renderTranscript(
      [...saying(link("m1"))],
      { thread: "a2", title: "Kyoto trip", root: "m1" },
      undefined,
      true,
    );
    // l1 is outside the thread in focus and so hidden, but the chip, if drawn, is no button.
    expect(screen.queryByRole("button", { name: /Open the thread:/ })).toBeNull();
  });

  it("reads as its label in every text read as plain words", () => {
    const text = link("m1");
    expect(plainQuote(text)).toBe("See Flights for the flights.");
    expect(quoteLine(text)).toBe("See Flights for the flights.");
    // An image keeps its markup: only a link reads as its text.
    expect(plainQuote("![chart](x.png)")).toBe("![chart](x.png)");
  });
});
