// @rstest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import "@/i18n";
import { ConciergeTranscript } from "@/components/chat/ConciergeTranscript";
import { buildRows } from "@/components/chat/chat-view";
import type { BlockActions, LivePreview } from "@/components/chat/MessageList";
import { EMPTY_LIVE_TEXT } from "@/hooks/live-text";
import { ThemeProvider } from "@/hooks/use-theme";
import * as chatApiModule from "@/lib/chat-api" with { rstest: "importActual" };
import { getThreadPage } from "@/lib/chat-api";
import type { ChatMessage } from "@/lib/chat-types";
import { ChainFocusLayer } from "./ChainFocusLayer";
import { ReplyBar } from "./ReplyBar";
import { ReplyDraftProvider, useReplyDraftState } from "./reply-draft";
import { useChainFocus } from "./use-chain-focus";

// A reply chain opens in place from the quote of one of its replies
// (docs/domains/chats.md#chat-thread).

rs.mock("@/lib/chat-api", () => ({ ...chatApiModule, getThreadPage: rs.fn() }));
rs.mock("@/hooks/use-dashboard-identity", () => ({
  useDashboardIdentity: () => ({
    data: { kind: "guardian", userId: "seat", displayName: "Ray", avatarUrl: null },
  }),
}));

const thread = rs.mocked(getThreadPage);

beforeEach(() => {
  thread.mockReset();
  rs.stubGlobal("IntersectionObserver", undefined);
  stubMedia(false);
});
afterEach(() => {
  cleanup();
  rs.restoreAllMocks();
  rs.unstubAllGlobals();
  Reflect.deleteProperty(document, "startViewTransition");
  Reflect.deleteProperty(Element.prototype, "startViewTransition");
});

function stubMedia(reduced: boolean) {
  rs.stubGlobal(
    "matchMedia",
    rs.fn((query: string) => ({
      matches: reduced && query === "(prefers-reduced-motion: reduce)",
      media: query,
      addEventListener: rs.fn(),
      removeEventListener: rs.fn(),
    })),
  );
}

const at = (minute: number) => new Date(2026, 10, 9, 9, minute).toISOString();

const say = (
  id: string,
  role: "user" | "assistant",
  text: string,
  minute: number,
  options: { root?: string; replyTo?: [string, string] } = {},
): ChatMessage =>
  ({
    id,
    sessionId: "concierge",
    turnId: role === "assistant" ? `t-${id}` : null,
    role,
    content: JSON.stringify([
      ...(options.replyTo
        ? [
            {
              type: "reply_to",
              messageId: options.replyTo[0],
              author: options.replyTo[0].startsWith("g") ? "guardian" : "agent",
              text: options.replyTo[1],
            },
          ]
        : []),
      ...(text ? [{ type: "text", content: text }] : []),
    ]),
    createdAt: at(minute),
    chatThreadId: options.root ?? id,
  }) as ChatMessage;

// The chat: a chain rooted at g1, with unrelated messages between its messages.
const g1 = say("g1", "user", "Plan Tokyo for May", 0);
const x1 = say("x1", "assistant", "Weather is clear today", 1);
const a1 = say("a1", "assistant", "Which days?", 2, { root: "g1", replyTo: ["g1", g1.content] });
const x2 = say("x2", "user", "Remind me to call Ana", 3);
const a2 = say("a2", "assistant", "I found two hotels", 4, {
  root: "g1",
  replyTo: ["g1", "Plan Tokyo for May"],
});
const g2 = say("g2", "user", "The cheaper one", 5, {
  root: "g1",
  replyTo: ["a2", "I found two hotels"],
});
const main = [g1, x1, a1, x2, a2, g2, say("x3", "assistant", "Done with Ana", 6)];
const chain = [g1, a1, a2, g2];

const idle = {
  isStreaming: false,
  runningTurnId: null,
  snapshot: null,
  textStore: EMPTY_LIVE_TEXT,
  identity: { name: "Rome", iconUrl: null },
} as LivePreview;
const actions = {
  onApprovalResolved: () => {},
  onSubmitAppComponent: () => {},
  onDismissAppComponent: () => {},
  interactionResults: new Map(),
} as BlockActions;

interface Seen {
  chain?: ReturnType<typeof useChainFocus>;
  draft?: ReturnType<typeof useReplyDraftState>;
  fallback: ReturnType<typeof rs.fn>;
}

/** The chat's wiring of the chain focus: the transcript under a layer, and the composer's reply bar. */
function Harness({ seen }: { seen: Seen }) {
  const [scroller, setScroller] = useState<HTMLElement | null>(null);
  const focus = useChainFocus({ sessionId: "concierge", scroller, fallback: seen.fallback });
  seen.chain = focus;
  const draft = useReplyDraftState({
    chatId: "concierge",
    sessionId: "concierge",
    jump: focus.open,
    onDismiss: focus.close,
    focusComposer: () => {},
  });
  seen.draft = draft;
  const rows = buildRows(main, new Map(), idle.identity, {
    runningTurnId: null,
    isStreaming: false,
  });
  return (
    <ReplyDraftProvider value={draft}>
      <div ref={focus.scope} data-message-list className="relative">
        <div ref={setScroller} data-testid="main">
          <div className="contents" style={focus.focus ? { visibility: "hidden" } : undefined}>
            <ConciergeTranscript rows={rows} live={idle} actions={actions} contentRef={() => {}} />
          </div>
        </div>
        {focus.focus ? (
          <ChainFocusLayer
            focus={focus.focus}
            layerRef={focus.layer}
            floor={null}
            identityBySession={new Map()}
            identity={idle.identity}
            actions={actions}
            onMore={focus.more}
            onClose={focus.close}
          />
        ) : null}
        {focus.focus ? (
          <button type="button" aria-label="Close reply chain" onClick={focus.close} />
        ) : null}
        <ReplyBar />
      </div>
    </ReplyDraftProvider>
  );
}

function renderChat() {
  const seen: Seen = { fallback: rs.fn() };
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <MemoryRouter>
        <ThemeProvider>
          <Harness seen={seen} />
        </ThemeProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return seen;
}

/** A layer much taller than its view, so jsdom's empty layout does not read as an end. */
const stubTall = () => {
  rs.spyOn(Element.prototype, "scrollHeight", "get").mockReturnValue(5000);
  rs.spyOn(Element.prototype, "clientHeight", "get").mockReturnValue(500);
};

const mainEl = () => screen.getByTestId("main");
const layer = () => document.querySelector<HTMLElement>("[data-chain-layer]");
const bubbleIds = (root: HTMLElement) =>
  [...root.querySelectorAll<HTMLElement>("[data-message-part]")].map((b) => b.dataset.messagePart);
const scrollerOf = () => document.querySelector<HTMLElement>("[data-chain-layer] > div")!;

/** The page the server answers for the window of the chain around a2. */
const page = (messages: ChatMessage[], edges: { hasOlder?: boolean; hasNewer?: boolean } = {}) => ({
  messages,
  hasOlder: false,
  hasNewer: false,
  ...edges,
});

/** Presses the quote of message `id` in the chat and waits for the layer. */
async function pressQuote(id: string) {
  const bubble = within(mainEl())
    .getAllByRole("button", { name: "Go to the original message" })
    .find(
      (button) => button.closest("[data-message-part]")?.getAttribute("data-message-part") === id,
    );
  await act(async () => {
    fireEvent.click(bubble!);
  });
}

describe("opening a chain from a quote", () => {
  it("reads the chain around the pressed message with limit 10 and shows it as a layer over the chat", async () => {
    thread.mockResolvedValue(page(chain));
    renderChat();
    await pressQuote("a2");
    expect(thread).toHaveBeenCalledWith("concierge", "a2", { limit: 10 });
    await waitFor(() => expect(layer()).not.toBeNull());
    expect(bubbleIds(layer()!)).toEqual(["g1", "a1", "a2", "g2"]);
    // The chat stays mounted under the layer, out of sight and whole.
    expect(bubbleIds(mainEl())).toEqual(["g1", "x1", "a1", "x2", "a2", "g2", "x3"]);
    expect((mainEl().firstElementChild as HTMLElement).style.visibility).toBe("hidden");
  });

  it("draws a quote left in the layer as plain text", async () => {
    thread.mockResolvedValue(page(chain));
    renderChat();
    await pressQuote("a2");
    await waitFor(() => expect(layer()).not.toBeNull());
    const quotes = layer()!.querySelectorAll("[data-reply-quote]");
    expect(quotes).toHaveLength(1);
    expect(quotes[0]?.tagName).toBe("DIV");
    expect(
      within(layer()!).queryByRole("button", { name: "Go to the original message" }),
    ).toBeNull();
  });

  it("goes to the original where the server has no chain to open", async () => {
    thread.mockResolvedValue(null);
    const seen = renderChat();
    await pressQuote("a2");
    expect(seen.fallback).toHaveBeenCalledWith("g1");
    expect(layer()).toBeNull();
  });

  it("goes to the original when the read fails", async () => {
    thread.mockRejectedValue(new Error("offline"));
    const seen = renderChat();
    await pressQuote("a2");
    expect(seen.fallback).toHaveBeenCalledWith("g1");
    expect(layer()).toBeNull();
  });
});

describe("placing a chain", () => {
  for (const [kind, natural, end] of [
    ["short", 552, 731],
    ["long", 2000, 2500],
  ] as const) {
    for (const y of [130, 483, 700]) {
      it(`keeps a ${kind} chain's pressed bubble at y${y}, including a viewport taller than its content`, async () => {
        const offsets = new WeakMap<Element, number>();
        const rect = (top: number, height = 66) =>
          ({
            top,
            bottom: top + height,
            height,
            left: 0,
            right: 600,
            width: 600,
            x: 0,
            y: top,
            toJSON: () => ({}),
          }) as DOMRect;
        rs.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function () {
          return Number.parseFloat(this.style.height) || 0;
        });
        rs.spyOn(Element.prototype, "clientHeight", "get").mockReturnValue(900);
        rs.spyOn(Element.prototype, "scrollHeight", "get").mockImplementation(function () {
          const top = this.querySelector<HTMLElement>("[data-chain-top]")?.offsetHeight ?? 0;
          const bottom = this.querySelector<HTMLElement>("[data-chain-bottom]")?.offsetHeight ?? 0;
          return Math.max(900, top + end + bottom);
        });
        rs.spyOn(Element.prototype, "scrollTop", "get").mockImplementation(function () {
          return offsets.get(this) ?? 0;
        });
        rs.spyOn(Element.prototype, "scrollTop", "set").mockImplementation(function (value) {
          offsets.set(this, Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight)));
        });
        rs.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function () {
          const scroller = this.closest<HTMLElement>("[data-chain-layer] > div");
          const blank = scroller?.querySelector<HTMLElement>("[data-chain-top]")?.offsetHeight ?? 0;
          const offset = scroller?.scrollTop ?? 0;
          if (this.hasAttribute("data-chain-content")) return rect(blank - offset, end);
          if (this.getAttribute("data-timeline-anchor") === "a2")
            return rect(scroller ? natural + blank - offset : y);
          return rect(0, 900);
        });
        thread.mockResolvedValue(page(chain));
        const seen = renderChat();
        await pressQuote("a2");
        await waitFor(() => expect(layer()).not.toBeNull());
        const anchor = layer()!.querySelector<HTMLElement>('[data-timeline-anchor="a2"]')!;
        expect(anchor.getBoundingClientRect().top).toBe(y);
        const content = layer()!.querySelector<HTMLElement>("[data-chain-content]")!;
        expect(content.className).toContain("shrink-0");
        expect(content.className).not.toContain("flex-1");
        await act(async () => seen.chain!.close());
        expect(
          mainEl().querySelector('[data-timeline-anchor="a2"]')!.getBoundingClientRect().top,
        ).toBe(y);
      });
    }
  }
});

describe("paging inside the layer", () => {
  it("reads 20 above the first message when the view is at the top and the chain has older ones", async () => {
    const earlier = [say("e1", "user", "First idea", -2, { root: "g1" })];
    thread
      .mockResolvedValueOnce(page(chain, { hasOlder: true }))
      .mockResolvedValueOnce(page(earlier));
    renderChat();
    await pressQuote("a2");
    await waitFor(() =>
      expect(thread).toHaveBeenCalledWith("concierge", "a2", { limit: 20, before: "g1" }),
    );
    await waitFor(() => expect(bubbleIds(layer()!)).toEqual(["e1", "g1", "a1", "a2", "g2"]));
  });

  it("reads 20 below the last message when the view is at the bottom and the chain has newer ones", async () => {
    const later = [say("a3", "assistant", "Booked", 8, { root: "g1" })];
    thread
      .mockResolvedValueOnce(page(chain, { hasNewer: true }))
      .mockResolvedValueOnce(page(later));
    renderChat();
    await pressQuote("a2");
    await waitFor(() =>
      expect(thread).toHaveBeenCalledWith("concierge", "a2", { limit: 20, after: "g2" }),
    );
    await waitFor(() => expect(bubbleIds(layer()!)).toEqual(["g1", "a1", "a2", "g2", "a3"]));
    expect(thread).toHaveBeenCalledTimes(2);
  });

  it("waits for the view to come near an end before it reads", async () => {
    stubTall();
    const later = [say("a3", "assistant", "Booked", 8, { root: "g1" })];
    thread
      .mockResolvedValueOnce(page(chain, { hasNewer: true }))
      .mockResolvedValueOnce(page(later));
    renderChat();
    await pressQuote("a2");
    await waitFor(() => expect(layer()).not.toBeNull());
    expect(thread).toHaveBeenCalledTimes(1);
    await act(async () => {
      scrollerOf().scrollTop = 4200;
      fireEvent.scroll(scrollerOf());
    });
    await waitFor(() => expect(bubbleIds(layer()!)).toEqual(["g1", "a1", "a2", "g2", "a3"]));
  });

  it("reads nothing more when the chain ends both ways", async () => {
    thread.mockResolvedValue(page(chain));
    renderChat();
    await pressQuote("a2");
    await waitFor(() => expect(layer()).not.toBeNull());
    expect(thread).toHaveBeenCalledTimes(1);
  });
});

describe("a message that arrives while the layer is open", () => {
  const arrives = (message: ChatMessage, seen: Seen) => act(() => seen.chain!.onLive(message));

  it("joins the layer when it is of the chain and the layer holds the newest end", async () => {
    thread.mockResolvedValue(page(chain));
    const seen = renderChat();
    await pressQuote("a2");
    await waitFor(() => expect(layer()).not.toBeNull());
    await arrives(say("a3", "assistant", "Booked", 8, { root: "g1" }), seen);
    await arrives(say("x4", "assistant", "Unrelated", 9), seen);
    expect(bubbleIds(layer()!)).toEqual(["g1", "a1", "a2", "g2", "a3"]);
  });

  it("is left out while the layer holds only part of the chain", async () => {
    stubTall();
    thread.mockResolvedValue(page(chain, { hasNewer: true }));
    const seen = renderChat();
    await pressQuote("a2");
    await waitFor(() => expect(layer()).not.toBeNull());
    await arrives(say("a3", "assistant", "Booked", 8, { root: "g1" }), seen);
    expect(bubbleIds(layer()!)).toEqual(["g1", "a1", "a2", "g2"]);
  });

  it("replaces a message the layer holds where it stands, even when the layer lacks the newest end", async () => {
    stubTall();
    thread.mockResolvedValue(page(chain, { hasNewer: true }));
    const seen = renderChat();
    await pressQuote("a2");
    await waitFor(() => expect(layer()).not.toBeNull());
    await arrives(say("a1", "assistant", "Which days in May?", 2, { root: "g1" }), seen);
    expect(bubbleIds(layer()!)).toEqual(["g1", "a1", "a2", "g2"]);
    expect(within(layer()!).getByText("Which days in May?")).toBeTruthy();
  });
});

describe("the composer", () => {
  const bar = () => document.querySelector<HTMLElement>("[data-reply-bar]");

  it("does not pick a reply on focus, live updates, or after a send clears the draft", async () => {
    thread.mockResolvedValue(page(chain));
    const seen = renderChat();
    await pressQuote("a2");
    expect(layer()).not.toBeNull();
    expect(seen.draft!.target).toBeNull();
    expect(bar()).toBeNull();
    act(() => seen.chain!.onLive(say("a3", "assistant", "Booked it", 8, { root: "g1" })));
    expect(seen.draft!.target).toBeNull();
    expect(bar()).toBeNull();
    act(() => seen.draft!.clear());
    expect(seen.draft!.target).toBeNull();
    expect(bar()).toBeNull();
    expect(layer()).not.toBeNull();
  });

  it("preserves an ordinary explicit reply through focus, new messages, and close", async () => {
    thread.mockResolvedValue(page(chain));
    const seen = renderChat();
    const manual = { messageId: "x1", author: "agent" as const, preview: "Weather is clear today" };
    act(() => seen.draft!.set(manual, { quiet: true }));
    await pressQuote("a2");
    expect(seen.draft!.target).toEqual(manual);
    act(() => seen.chain!.onLive(say("a3", "assistant", "Booked it", 8, { root: "g1" })));
    expect(seen.draft!.target).toEqual(manual);
    await act(async () => {
      await seen.chain!.close();
    });
    expect(seen.draft!.target).toEqual(manual);
    expect(bar()?.getAttribute("title")).toBe(manual.preview);
  });

  it("keeps an explicitly picked reply's normal cancel behavior", async () => {
    thread.mockResolvedValue(page(chain));
    const seen = renderChat();
    await pressQuote("a2");
    act(() =>
      seen.draft!.set(
        { messageId: "g1", author: "guardian", preview: "Plan Tokyo" },
        { quiet: true },
      ),
    );
    expect(bar()).not.toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Cancel reply" }));
    });
    expect(layer()).toBeNull();
    expect(bar()).toBeNull();
  });
});

describe("closing", () => {
  async function open() {
    thread.mockResolvedValue(page(chain));
    const seen = renderChat();
    await pressQuote("a2");
    await waitFor(() => expect(layer()).not.toBeNull());
    return seen;
  }

  it("closes with the button, and the chat is as it was", async () => {
    await open();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Close reply chain" }));
    });
    expect(layer()).toBeNull();
    expect((mainEl().firstElementChild as HTMLElement).style.visibility).toBe("");
    expect(bubbleIds(mainEl())).toHaveLength(7);
  });

  it("closes with a click on blank space, and not with one on a message, a link or a selection", async () => {
    await open();
    const bubble = layer()!.querySelector("[data-concierge-bubble-part]")!;
    await act(async () => {
      fireEvent.click(bubble);
    });
    expect(layer()).not.toBeNull();
    const getSelection = rs.spyOn(window, "getSelection");
    getSelection.mockReturnValue({ isCollapsed: false } as Selection);
    await act(async () => {
      fireEvent.click(scrollerOf());
    });
    expect(layer()).not.toBeNull();
    getSelection.mockRestore();
    await act(async () => {
      fireEvent.click(scrollerOf());
    });
    expect(layer()).toBeNull();
  });

  it("closes with Escape unless something used the key first", async () => {
    await open();
    const used = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
    used.preventDefault();
    await act(async () => {
      document.dispatchEvent(used);
    });
    expect(layer()).not.toBeNull();
    await act(async () => {
      fireEvent.keyDown(document, { key: "Escape" });
    });
    expect(layer()).toBeNull();
  });
});

describe("the view transition", () => {
  const nameOf = (root: ParentNode, id: string) =>
    root
      .querySelector<HTMLElement>(`[data-message-part="${id}"]`)
      ?.style.getPropertyValue("view-transition-name");

  /** A browser that runs the update when told to, and ends the transition when asked. */
  function stubTransition() {
    const seen: {
      before: Record<string, string | undefined>;
      during: Record<string, string | undefined>;
    } = {
      before: {},
      during: {},
    };
    let end!: () => void;
    const start = rs.fn(function (this: HTMLElement, update: () => void) {
      expect(this).toBe(mainEl().closest("[data-message-list]"));
      for (const id of ["g1", "a1", "x1"]) seen.before[id] = nameOf(mainEl(), id);
      update();
      for (const id of ["g1", "a1", "x1"])
        seen.during[id] = nameOf(mainEl(), id) ?? nameOf(layer() ?? document, id);
      return { finished: new Promise<void>((resolve) => (end = resolve)) };
    });
    Object.defineProperty(Element.prototype, "startViewTransition", {
      value: start,
      configurable: true,
    });
    return { start, seen, end: () => end() };
  }

  it("names the chain's messages in the old picture, moves the names to the layer, and clears them when it ends", async () => {
    thread.mockResolvedValue(page(chain));
    renderChat();
    const motion = stubTransition();
    await pressQuote("a2");
    await waitFor(() => expect(motion.start).toHaveBeenCalledTimes(1));
    // Named on the chat's own messages of the chain, not on the others.
    expect(motion.seen.before).toEqual({ g1: "tm-g1-0", a1: "tm-a1-0", x1: "" });
    // Then on the layer's, and no longer on the chat's.
    expect(nameOf(mainEl(), "g1")).toBe("");
    expect(nameOf(layer()!, "g1")).toBe("tm-g1-0");
    expect(document.documentElement.hasAttribute("data-chain-transition")).toBe(false);
    expect(mainEl().closest("[data-message-list]")!.hasAttribute("data-chain-transition")).toBe(
      true,
    );
    await act(async () => motion.end());
    await waitFor(() => expect(nameOf(layer()!, "g1")).toBe(""));
    expect(document.documentElement.hasAttribute("data-chain-transition")).toBe(false);
    expect(mainEl().closest("[data-message-list]")!.hasAttribute("data-chain-transition")).toBe(
      false,
    );
  });

  it("closes the other way: the layer's names go to the chat's messages, and clear when it ends", async () => {
    thread.mockResolvedValue(page(chain));
    const seen = renderChat();
    const motion = stubTransition();
    await pressQuote("a2");
    await waitFor(() => expect(motion.start).toHaveBeenCalledTimes(1));
    await act(async () => motion.end());
    await waitFor(() =>
      expect(document.documentElement.hasAttribute("data-chain-transition")).toBe(false),
    );
    let closing!: Promise<void>;
    await act(async () => {
      closing = seen.chain!.close();
    });
    await waitFor(() => expect(motion.start).toHaveBeenCalledTimes(2));
    expect(layer()).toBeNull();
    expect(nameOf(mainEl(), "g1")).toBe("tm-g1-0");
    expect(nameOf(mainEl(), "x1")).toBe("");
    await act(async () => {
      motion.end();
      await closing;
    });
    expect(nameOf(mainEl(), "g1")).toBe("");
  });

  it("switches at once for a reader who prefers reduced motion", async () => {
    stubMedia(true);
    thread.mockResolvedValue(page(chain));
    renderChat();
    const motion = stubTransition();
    await pressQuote("a2");
    await waitFor(() => expect(layer()).not.toBeNull());
    expect(motion.start).not.toHaveBeenCalled();
    expect(nameOf(layer()!, "g1")).toBe("");
  });

  it("switches at once without Element support, never falling back to the document API", async () => {
    const documentStart = rs.fn();
    Object.defineProperty(document, "startViewTransition", {
      value: documentStart,
      configurable: true,
    });
    thread.mockResolvedValue(page(chain));
    renderChat();
    await pressQuote("a2");
    await waitFor(() => expect(layer()).not.toBeNull());
    expect(documentStart).not.toHaveBeenCalled();
    expect(document.querySelector("[data-chain-transition]")).toBeNull();
  });
});

describe("newest-page catch-up in focus", () => {
  it("brings the guardian's own stored send in after a shared boundary, without appending across a gap", async () => {
    thread.mockResolvedValueOnce(page(chain)).mockResolvedValueOnce(page([]));
    const seen = renderChat();
    await act(async () => {
      await seen.chain!.open("g1", "a2");
    });
    const sent = say("g3", "user", "Book it", 7, {
      root: "g1",
      replyTo: ["g2", "The cheaper one"],
    });
    await act(async () => seen.chain!.onPage([sent]));
    expect(seen.chain!.focus!.messages.map((message) => message.id)).not.toContain("g3");
    act(() => seen.chain!.onPage([g2, sent]));
    expect(seen.chain!.focus!.messages.map((message) => message.id)).toEqual([
      "g1",
      "a1",
      "a2",
      "g2",
      "g3",
    ]);
  });

  it("replaces loaded rows while a newer page remains, but leaves the gap for after paging", async () => {
    stubTall();
    thread.mockResolvedValueOnce(page(chain, { hasNewer: true }));
    const seen = renderChat();
    await act(async () => {
      await seen.chain!.open("g1", "a2");
    });
    const sent = say("g3", "user", "Book it", 7, { root: "g1" });
    act(() => seen.chain!.onPage([{ ...g2, content: "edited" }, sent]));
    expect(seen.chain!.focus!.messages.find((message) => message.id === "g2")!.content).toBe(
      "edited",
    );
    expect(seen.chain!.focus!.messages.map((message) => message.id)).not.toContain("g3");
  });
});

it("catches up a new turn's trace after the guardian's own send", async () => {
  thread.mockResolvedValueOnce(page(chain));
  const seen = renderChat();
  await act(async () => {
    await seen.chain!.open("g1", "a2");
  });
  const sent = { ...say("g3", "user", "Book it", 7, { root: "g1" }), turnId: "turn3" };
  const trace = {
    ...sent,
    id: "trace3",
    role: "trace",
    chatThreadId: undefined,
    content: "[]",
  } as ChatMessage;
  act(() => seen.chain!.onPage([g2, sent, trace]));
  expect(seen.chain!.focus!.messages.map((message) => message.id)).toEqual([
    "g1",
    "a1",
    "a2",
    "g2",
    "g3",
    "trace3",
  ]);
});

it("reconciles an old chain's own send before an answer that already arrived live", async () => {
  const sent = say("g3", "user", "Book it", 7, { root: "g1" });
  const answer = say("a3", "assistant", "Booked", 8, { root: "g1" });
  thread.mockResolvedValueOnce(page(chain)).mockResolvedValueOnce(page([sent, answer]));
  const seen = renderChat();
  await act(async () => {
    await seen.chain!.open("g1", "a2");
  });
  act(() => seen.chain!.onLive(answer));
  await act(async () => seen.chain!.onPage([sent, answer]));
  expect(thread).toHaveBeenLastCalledWith("concierge", "a2", { limit: 20, after: "g2" });
  expect(seen.chain!.focus!.messages.map((message) => message.id)).toEqual([
    "g1",
    "a1",
    "a2",
    "g2",
    "g3",
    "a3",
  ]);
});

it("keeps a live arrival after the earlier server page while reconciling an old chain", async () => {
  const sent = say("g3", "user", "Book it", 7, { root: "g1" });
  const answer = say("a3", "assistant", "Booked", 8, { root: "g1" });
  let resolve!: (value: ReturnType<typeof page>) => void;
  thread.mockResolvedValueOnce(page(chain)).mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const seen = renderChat();
  await act(async () => {
    await seen.chain!.open("g1", "a2");
  });
  act(() => seen.chain!.onPage([sent]));
  act(() => seen.chain!.onLive(answer));
  await act(async () => resolve(page([sent])));
  expect(seen.chain!.focus!.messages.map((message) => message.id)).toEqual([
    "g1",
    "a1",
    "a2",
    "g2",
    "g3",
    "a3",
  ]);
});

it("reads a focused own send at acceptance, without waiting for the answer to finish", async () => {
  const sent = say("g3", "user", "Book it", 7, { root: "g1" });
  thread.mockResolvedValueOnce(page(chain)).mockResolvedValueOnce(page([sent]));
  const seen = renderChat();
  await act(async () => {
    await seen.chain!.open("g1", "a2");
  });
  await act(async () => {
    await seen.chain!.reconcile();
  });
  expect(thread).toHaveBeenLastCalledWith("concierge", "a2", { limit: 20, after: "g2" });
  expect(seen.chain!.focus!.messages.at(-1)?.id).toBe("g3");
});

it("coalesces an accepted-send refresh while another thread page is in flight", async () => {
  const first = say("g3", "user", "First", 7, { root: "g1" });
  const second = say("g4", "user", "Second", 8, { root: "g1" });
  let finish!: (value: ReturnType<typeof page>) => void;
  thread
    .mockResolvedValueOnce(page(chain))
    .mockImplementationOnce(
      () =>
        new Promise((done) => {
          finish = done;
        }),
    )
    .mockResolvedValueOnce(page([second]));
  const seen = renderChat();
  await act(async () => {
    await seen.chain!.open("g1", "a2");
  });
  act(() => {
    void seen.chain!.reconcile();
  });
  await act(async () => {
    await seen.chain!.reconcile();
  });
  await act(async () => finish(page([first])));
  await waitFor(() => expect(seen.chain!.focus!.messages.at(-1)?.id).toBe("g4"));
  expect(thread).toHaveBeenLastCalledWith("concierge", "a2", { limit: 20, after: "g3" });
});
