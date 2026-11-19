// @rstest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import type { ChatMessage } from "@/lib/chat-types";
import "@/i18n";
import { EMPTY_LIVE_TEXT } from "@/hooks/live-text";
import { ThemeProvider } from "@/hooks/use-theme";
import { mergeFetchedChatMessages } from "@/lib/chat-message-ordering";
import { ConciergeTranscript } from "./ConciergeTranscript";
import { buildChatView, buildRows } from "./chat-view";
import { buildConciergeItems } from "./concierge-groups";
import type { BlockActions, LivePreview } from "./MessageList";
import { replyDrawings, type ReplyDrawing } from "./reply/reply-drawing";
import { ReplyDraftProvider, useReplyDraftState } from "./reply/reply-draft";

// How a Concierge chat draws what a message replies to
// (docs/domains/chats.md#chat-thread): in time order, a plain bubble under what
// it answers, a run of replies to one message close together, and a quote in
// the bubble for any other reply.

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
      // A phone, where a tap on a bubble opens its details.
      matches: query === "(hover: none)",
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

const at = (minute: number) => new Date(2026, 10, 9, 9, minute).toISOString();

/** The quote a reply carries: the message it replies to and what it said. */
type Quote = { messageId: string; author: "guardian" | "agent"; text: string };

const say = (
  id: string,
  role: "user" | "assistant",
  text: string,
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
  }) as ChatMessage;

/** The guardian's message `id` and a quote of it, as a reply to it carries. */
const asks = (id: string, text: string, minute: number) => say(id, "user", text, minute);
const quoteOf = (id: string, text: string, author: "guardian" | "agent" = "guardian"): Quote => ({
  messageId: id,
  author,
  text,
});

const idle = {
  isStreaming: false,
  runningTurnId: null,
  snapshot: null,
  textStore: EMPTY_LIVE_TEXT,
  identity: { name: "Rome", iconUrl: null },
} as LivePreview;

const rowsOf = (shown: ChatMessage[]) =>
  buildRows(shown, new Map(), idle.identity, { runningTurnId: null, isStreaming: false });

/** How each message draws its reply, as the transcript computes it. */
const drawn = (shown: ChatMessage[]): Map<string, ReplyDrawing> =>
  replyDrawings(buildConciergeItems(rowsOf(shown), { typing: false }));

const actions = {
  onApprovalResolved: () => {},
  onSubmitAppComponent: () => {},
  onDismissAppComponent: () => {},
  interactionResults: new Map(),
} as BlockActions;

function renderTranscript(shown: ChatMessage[]) {
  const jumps: string[] = [];
  function Chat() {
    const draft = useReplyDraftState({
      chatId: "concierge",
      sessionId: "concierge",
      jump: (id) => {
        jumps.push(id);
      },
      focusComposer: () => {},
    });
    return (
      <MemoryRouter>
        <ReplyDraftProvider value={draft}>
          <ThemeProvider>
            <ConciergeTranscript
              rows={rowsOf(shown)}
              live={idle}
              actions={actions}
              contentRef={() => {}}
            />
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
  return jumps;
}

/** The quote buttons in the transcript, in order: each is the quote of one reply. */
const quotes = () => [...document.querySelectorAll<HTMLElement>("[data-reply-quote]")];
const entryOf = (id: string) =>
  document.querySelector<HTMLElement>(`[data-timeline-anchor~="${id}"]`)!;
const quoteIn = (id: string) => entryOf(id).querySelector<HTMLElement>("[data-reply-quote]");
/** The `data-join` of the box that holds message `id`. */
const joinOf = (id: string) => entryOf(id).closest("[data-join]")?.getAttribute("data-join");

const ask = asks("g1", "What is on tomorrow?", 0);
const askedQuote = quoteOf("g1", "What is on tomorrow?");
/** The Concierge's answer `id` to the question `g1`. */
const answer = (id: string, minute: number, text = `said ${id}`, quote = askedQuote) =>
  say(id, "assistant", text, minute, quote);

describe("how a reply is drawn", () => {
  it("draws a message that replies to nothing, or to the owner message right above it, plain", () => {
    const drawings = drawn([
      ask,
      answer("a1", 1, "Three things.", quoteOf("g1", "What is on tomorrow?")),
      say("a2", "assistant", "By the way", 2),
    ]);
    expect(drawings.get("a1")?.quote).toBe(false);
    expect(drawings.has("a2")).toBe(false);
  });

  it("joins a message to the Concierge message above that replies to the same one, first, middle and last", () => {
    const drawings = drawn([ask, answer("a1", 1), answer("a2", 1), answer("a3", 2)]);
    expect([...drawings].map(([id, d]) => [id, d.quote, d.join])).toEqual([
      ["a1", false, "first"],
      ["a2", false, "mid"],
      ["a3", false, "last"],
    ]);
  });

  it("shows a quote on a reply to a message that is not right above it, and ends the run there", () => {
    const other = asks("g2", "Book Tokyo", 3);
    const drawings = drawn([
      ask,
      answer("a1", 1),
      answer("a2", 1),
      other,
      // The owner's message above ends the run: a3 replies to g1, not to it.
      answer("a3", 4),
      answer("a4", 4, "later", quoteOf("g2", "Book Tokyo")),
    ]);
    expect(drawings.get("a2")?.join).toBe("last");
    expect(drawings.get("a3")).toEqual({ quote: true });
    expect(drawings.get("a4")).toEqual({ quote: true });
  });

  it("starts a new run for another reply even when it is the Concierge message above that it answers", () => {
    const drawings = drawn([
      ask,
      answer("a1", 1),
      // A reply to the Concierge's own message right above it: not the owner's, so a quote.
      say("a2", "assistant", "More", 2, quoteOf("a1", "said a1", "agent")),
    ]);
    expect(drawings.get("a1")?.quote).toBe(false);
    expect(drawings.get("a2")).toEqual({ quote: true });
  });

  it("keeps a run whole across a gap of minutes, and ends it at a time line", () => {
    const kept = drawn([ask, answer("a1", 1), answer("a2", 12)]);
    expect(kept.get("a2")).toEqual({ quote: false, join: "last" });
    // An hour later a time line stands between them.
    const split = drawn([ask, answer("a1", 1), answer("a2", 75)]);
    expect(split.get("a2")).toEqual({ quote: true });
    expect(split.get("a1")?.join).toBeUndefined();
  });

  it("never joins two messages that reply to nothing", () => {
    const drawings = drawn([
      say("a1", "assistant", "Routine one", 1),
      say("a2", "assistant", "Routine two", 2),
    ]);
    expect(drawings.size).toBe(0);
  });

  it("shows a quote on the owner's reply always, even to the message right above", () => {
    const drawings = drawn([
      ask,
      answer("a1", 1),
      say("g2", "user", "Good", 2, quoteOf("a1", "said a1", "agent")),
    ]);
    expect(drawings.get("g2")).toEqual({ quote: true });
  });
});

describe("the transcript", () => {
  it("draws the quote of a reply that is not under what it answers, in its bubble", () => {
    renderTranscript([
      ask,
      answer("a1", 1),
      asks("g2", "Book Tokyo", 2),
      say("a2", "assistant", "Checking Tokyo", 3, quoteOf("g1", "What is on tomorrow?")),
    ]);
    expect(quotes().map((quote) => quote.dataset.replyQuote)).toEqual(["g1"]);
    const bubble = screen.getByText("Checking Tokyo").closest("[data-concierge-bubble]")!;
    expect(bubble.contains(quotes()[0]!)).toBe(true);
    expect(within(quotes()[0]!).getByText("What is on tomorrow?")).toBeTruthy();
  });

  it("marks the runs for the bubbles to draw closer, and nothing else", () => {
    renderTranscript([ask, answer("a1", 1), answer("a2", 1), answer("a3", 2)]);
    expect([joinOf("a1"), joinOf("a2"), joinOf("a3")]).toEqual(["first", "mid", "last"]);
    expect(joinOf("g1")).toBeUndefined();
    expect(quotes()).toHaveLength(0);
  });

  it("shows a quote in the owner's bubble for a reply to a message right above", () => {
    renderTranscript([
      ask,
      answer("a1", 1),
      say("g2", "user", "Good", 2, quoteOf("a1", "said a1", "agent")),
    ]);
    expect(within(quoteIn("g2")!).getByText("said a1")).toBeTruthy();
    expect(quoteIn("a1")).toBeNull();
  });

  it("goes to the original when the quote is pressed", () => {
    const jumps = renderTranscript([
      ask,
      answer("a1", 1),
      asks("g2", "Book Tokyo", 2),
      say("a2", "assistant", "Checking Tokyo", 3, quoteOf("g1", "What is on tomorrow?")),
    ]);
    fireEvent.click(quoteIn("a2")!);
    expect(jumps).toEqual(["g1"]);
  });

  it("puts the quote of a forwarded result in the first bubble, once", () => {
    const forward = {
      ...say("a3", "assistant", "", 5, quoteOf("g1", "What is on tomorrow?")),
      content: JSON.stringify([
        { type: "reply_to", ...quoteOf("g1", "What is on tomorrow?") },
        { type: "text", content: "Here it is" },
        {
          type: "text",
          content: "Ryokan by the river, 3 nights.",
          forwardedFrom: { chatId: "task-1", title: "Kyoto trip" },
        },
      ]),
    } as ChatMessage;
    renderTranscript([ask, answer("a1", 1), asks("g2", "Book Tokyo", 2), forward]);
    const entry = entryOf("a3");
    expect(entry.querySelectorAll("[data-reply-quote]")).toHaveLength(1);
    const first = screen.getByText("Here it is").closest("[data-concierge-bubble]")!;
    expect(first.contains(entry.querySelector("[data-reply-quote]"))).toBe(true);
  });

  it("shows a task's card with no quote of its own, and no Reply", () => {
    const card = {
      ...say("c1", "assistant", "", 4),
      content: JSON.stringify([
        { type: "task_chat", chatId: "task-1", title: "Kyoto", show: "ask" },
      ]),
    } as ChatMessage;
    renderTranscript([ask, answer("a1", 1), card]);
    const anchor = entryOf("c1");
    expect(anchor.querySelector("[data-reply-quote]")).toBeNull();
    fireEvent.click(within(anchor).getByRole("button", { name: "Message details" }));
    expect(within(anchor).queryByRole("button", { name: "Reply" })).toBeNull();
  });

  it("shows nothing of a thread: every message in order, no stack and no link", () => {
    renderTranscript([ask, answer("a1", 1), asks("g2", "Book Tokyo", 2), answer("a2", 3)]);
    expect(
      document.querySelector("[data-thread-stack], [data-thread-entry], [data-thread-out]"),
    ).toBeNull();
    expect(
      [...document.querySelectorAll("[data-timeline-anchor]")].map((el) =>
        el.getAttribute("data-timeline-anchor"),
      ),
    ).toEqual(["g1", "a1", "g2", "a2"]);
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

  it("sits under the Concierge's reply to a routine, names it, and opens nothing", () => {
    renderTranscript([
      trace("t-r1", 10, { type: "routine", name: "Daily summary" }),
      say("r1", "assistant", "said r1", 10),
    ]);
    const label = screen.getByText("Routine · Daily summary");
    expect(label.closest("button")).toBeNull();
    expect(label.closest("[data-source-label]")?.getAttribute("data-source-label")).toBe("routine");
  });

  it("shows nothing for an agent's input the Concierge did not answer", () => {
    renderTranscript([trace("t-x", 10, { type: "agent", name: "Flint" })]);
    expect(screen.queryByText(/Flint/)).toBeNull();
  });
});

describe("turns whose messages interleave, as the server pages them", () => {
  /** A message of turn `turnId`, as the server sends it: in `turnId` whichever page it is on. */
  const inTurn = (message: ChatMessage, turnId: string): ChatMessage => ({ ...message, turnId });
  const identity = { name: "Rome", iconUrl: null };
  /** What the chat draws once the pages are in, through the pipeline the chat uses. */
  const shownOf = (...pages: ChatMessage[][]) =>
    buildChatView(
      new Map([
        [
          "concierge",
          pages.reduce<ChatMessage[]>((all, page) => mergeFetchedChatMessages(all, page), []),
        ],
      ]),
      "concierge",
      identity,
    ).displayMessages;
  const anchors = () =>
    [...document.querySelectorAll("[data-timeline-anchor]")].map((el) =>
      el.getAttribute("data-timeline-anchor"),
    );

  it("draws owner-A, owner-B, answer-A, answer-B in that order after both pages load, each answer quoting its question", () => {
    const traceA = {
      id: "trace-a",
      sessionId: "concierge",
      turnId: "turn-a",
      role: "trace",
      content: "[]",
      createdAt: at(2),
    } as ChatMessage;
    const ownerA = inTurn(asks("owner-a", "First question", 0), "turn-a");
    const ownerB = inTurn(asks("owner-b", "Second question", 1), "turn-b");
    const answerA = inTurn(
      say("answer-a", "assistant", "First answer", 3, quoteOf("owner-a", "First question")),
      "turn-a",
    );
    const answerB = inTurn(
      say("answer-b", "assistant", "Second answer", 4, quoteOf("owner-b", "Second question")),
      "turn-b",
    );
    // The newest page holds the two answers, and the trace of A's turn comes along.
    const newest = [traceA, answerA, answerB];
    // The next page holds the two questions, and A's trace again.
    const older = [ownerA, ownerB, traceA];

    // The newest page alone leaves out the two questions.
    expect(shownOf(newest).map((m) => m.id)).toEqual(["trace-a", "answer-a", "answer-b"]);

    const shown = shownOf(newest, older);
    expect(shown.map((m) => m.id)).toEqual([
      "owner-a",
      "owner-b",
      "trace-a",
      "answer-a",
      "answer-b",
    ]);
    renderTranscript(shown);
    expect(anchors()).toEqual(["owner-a", "owner-b", "answer-a", "answer-b"]);
    // Neither answer sits under its question, so each carries a quote of it.
    expect(quotes().map((quote) => quote.dataset.replyQuote)).toEqual(["owner-a", "owner-b"]);
    expect(within(quoteIn("answer-a")!).getByText("First question")).toBeTruthy();
    expect(within(quoteIn("answer-b")!).getByText("Second question")).toBeTruthy();
  });

  it("keeps the source label of a turn whose trace is older than the messages of its page", () => {
    const routineTrace = {
      id: "trace-r",
      sessionId: "concierge",
      turnId: "turn-r",
      role: "trace",
      content: "[]",
      createdAt: at(1),
      traceSummary: {
        distinctApps: [],
        invocationCounts: {},
        totalSteps: 0,
        automatedInput: { type: "routine", name: "Daily summary" },
      },
    } as ChatMessage;
    // A routine's turn starts while the guardian's turn is open, and answers after it.
    const shown = shownOf([
      routineTrace,
      inTurn(
        say("answer-g", "assistant", "Guardian answer", 2, quoteOf("owner-g", "Question")),
        "turn-g",
      ),
      inTurn(say("answer-r", "assistant", "Routine report", 3), "turn-r"),
    ]);
    renderTranscript(shown);
    expect(anchors()).toEqual(["answer-g", "answer-r"]);
    expect(screen.getByText("Routine · Daily summary")).toBeTruthy();
  });
});
