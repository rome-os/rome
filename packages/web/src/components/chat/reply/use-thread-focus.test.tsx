// @rstest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { MemoryRouter } from "react-router-dom";
import "@/i18n";
import { EMPTY_LIVE_TEXT } from "@/hooks/live-text";
import { ThemeProvider } from "@/hooks/use-theme";
import type { ChatMessage } from "@/lib/chat-types";
import { ConciergeTranscript } from "../ConciergeTranscript";
import { buildRows } from "../chat-view";
import type { BlockActions, LivePreview } from "../MessageList";
import { ChatThreadsProvider, useChatThreadsValue } from "./chat-threads";
import { ReplyDraftProvider, useReplyDraftState } from "./reply-draft";
import { type Env, pin, useThreadFocus } from "./use-thread-focus";

rs.mock("@/hooks/use-dashboard-identity", () => ({
  useDashboardIdentity: () => ({
    data: { kind: "guardian", userId: "seat", displayName: "Ray", avatarUrl: null },
  }),
}));

let reduced = false;
beforeEach(() => {
  rs.stubGlobal("IntersectionObserver", undefined);
  rs.stubGlobal(
    "matchMedia",
    rs.fn((query: string) => ({
      matches: reduced && query === "(prefers-reduced-motion: reduce)",
      media: query,
      addEventListener: rs.fn(),
      removeEventListener: rs.fn(),
    })),
  );
});
afterEach(() => {
  cleanup();
  reduced = false;
  rs.unstubAllGlobals();
});

const at = (minute: number) => new Date(2026, 10, 9, 9, minute).toISOString();
const say = (
  id: string,
  role: "user" | "assistant",
  thread: string | null,
  minute: number,
  title?: string,
) =>
  ({
    id,
    sessionId: "concierge",
    turnId: role === "assistant" ? `t-${id}` : null,
    role,
    content: JSON.stringify([{ type: "text", content: `said ${id}` }]),
    createdAt: at(minute),
    chatThreadId: thread,
    ...(title ? { chatThreadTitle: title } : {}),
  }) as ChatMessage;

// Kyoto (k1 starts it) and Flights (f1) interleaved, with a message in none.
const chat = [
  say("k1", "user", "k1", 0, "Kyoto trip"),
  say("f1", "user", "f1", 1, "Flights"),
  say("k2", "assistant", "k1", 2),
  say("f2", "assistant", "f1", 3),
  say("free", "assistant", null, 4),
  say("k3", "assistant", "k1", 5),
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

/** Wires the hook to a real transcript the way Chat does: one draft, the labels, the back control. */
function Harness({
  messages = chat,
  chatId = "concierge",
}: {
  messages?: ChatMessage[];
  chatId?: string;
}) {
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const [content, setContent] = useState<HTMLElement | null>(null);
  const threadFocus = useThreadFocus({ scroller, content, resetKey: chatId });
  const threads = useChatThreadsValue(messages, new Map(), new Map(), threadFocus.shown);
  const draft = useReplyDraftState({
    chatId: "concierge",
    sessionId: "concierge",
    messageIds: new Set(messages.map((message) => message.id)),
    jump: () => {},
    focusComposer: () => {},
    onOpenThread: (next) => {
      if (threadFocus.focus) return void threadFocus.close();
      const root = threads.taskThreads.get(next.thread);
      if (root) void threadFocus.open({ ...next, root });
    },
    thread: threadFocus.focus,
  });
  const rows = buildRows(messages, new Map(), idle.identity, {
    runningTurnId: null,
    isStreaming: false,
  });
  return (
    <MemoryRouter>
      <ThemeProvider>
        <ReplyDraftProvider value={draft}>
          <div ref={setScroller} data-testid="scroller">
            <div ref={threadFocus.topSpace} data-testid="top-space" />
            <ChatThreadsProvider value={threads}>
              <ConciergeTranscript
                rows={rows}
                live={idle}
                actions={actions}
                contentRef={setContent}
              />
            </ChatThreadsProvider>
            <div ref={threadFocus.bottomSpace} data-testid="bottom-space" />
            <button type="button" onClick={() => void threadFocus.close()}>
              back
            </button>
            <p data-testid="focus">{threadFocus.focus?.title ?? ""}</p>
          </div>
        </ReplyDraftProvider>
      </ThemeProvider>
    </MemoryRouter>
  );
}

const entry = (id: string) => document.querySelector<HTMLElement>(`[data-thread-entry="${id}"]`)!;
const hidden = () =>
  [...document.querySelectorAll<HTMLElement>("[data-thread-entry]")]
    .filter((element) => element.closest("[data-thread-out]"))
    .map((element) => element.dataset.threadEntry)
    .sort();
const transcript = () => document.querySelector<HTMLElement>("[data-concierge-transcript]")!;
const kyotoLabels = () => screen.getAllByRole("button", { name: "Kyoto trip" });
const settled = () => act(async () => {});

describe("focusing a thread", () => {
  it("hides the messages of the other threads and of none, and keeps the thread's", async () => {
    reduced = true;
    render(<Harness />);
    expect(hidden()).toEqual([]);

    fireEvent.click(kyotoLabels()[0]!);
    await settled();

    expect(hidden()).toEqual(["f1", "f2", "free"]);
    expect(screen.getByTestId("focus").textContent).toBe("Kyoto trip");
    expect(kyotoLabels()[0]!.getAttribute("aria-pressed")).toBe("true");
  });

  it("closes from the same label, from the back control and from Esc, each restoring every message", async () => {
    reduced = true;
    render(<Harness />);
    for (const close of [
      () => fireEvent.click(kyotoLabels()[0]!),
      () => fireEvent.click(screen.getByRole("button", { name: "back" })),
      () => fireEvent.keyDown(document.body, { key: "Escape" }),
    ]) {
      fireEvent.click(kyotoLabels()[0]!);
      await settled();
      expect(hidden()).not.toEqual([]);

      close();
      await settled();

      expect(hidden()).toEqual([]);
      expect(screen.getByTestId("focus").textContent).toBe("");
      expect(kyotoLabels()[0]!.getAttribute("aria-pressed")).toBe("false");
      // No blank is left above or below.
      expect(screen.getByTestId("top-space").style.height).toBe("");
      expect(screen.getByTestId("bottom-space").style.height).toBe("");
      expect(transcript().hasAttribute("data-thread-motion")).toBe(false);
    }
  });

  it("leaves Esc to what handled it first, and to a composing keyboard", async () => {
    reduced = true;
    render(<Harness />);
    fireEvent.click(kyotoLabels()[0]!);
    await settled();

    const used = new KeyboardEvent("keydown", { key: "Escape", cancelable: true, bubbles: true });
    used.preventDefault();
    document.body.dispatchEvent(used);
    fireEvent.keyDown(document.body, { key: "Escape", isComposing: true });
    fireEvent.keyDown(document.body, { key: "Enter" });
    await settled();

    expect(screen.getByTestId("focus").textContent).toBe("Kyoto trip");
    expect(hidden()).toEqual(["f1", "f2", "free"]);
  });

  it("with reduced motion switches at once, asking for no animation frame", async () => {
    reduced = true;
    const frame = rs.spyOn(window, "requestAnimationFrame");
    render(<Harness />);
    fireEvent.click(kyotoLabels()[0]!);
    await settled();
    fireEvent.click(screen.getByRole("button", { name: "back" }));
    await settled();
    expect(frame).not.toHaveBeenCalled();
    expect(hidden()).toEqual([]);
  });

  it("otherwise folds the rows over a moment: they stay, shrinking, until the motion ends", async () => {
    render(<Harness />);
    fireEvent.click(kyotoLabels()[0]!);

    // The motion has begun: the rows are shown, held by inline styles.
    expect(transcript().hasAttribute("data-thread-motion")).toBe(true);
    expect(entry("f2").hasAttribute("data-thread-out")).toBe(true);
    expect(entry("f2").style.overflow).toBe("hidden");

    await waitFor(() => expect(transcript().hasAttribute("data-thread-motion")).toBe(false), {
      timeout: 2000,
    });
    // Over: the styles are released, and the rows are left to the stylesheet.
    expect(entry("f2").getAttribute("style") ?? "").toBe("");
    expect(hidden()).toEqual(["f1", "f2", "free"]);

    fireEvent.click(screen.getByRole("button", { name: "back" }));
    expect(transcript().hasAttribute("data-thread-motion")).toBe(true);
    expect(entry("f2").style.height).toBe("0px");
    await waitFor(() => expect(hidden()).toEqual([]), { timeout: 2000 });
    expect(entry("f2").getAttribute("style") ?? "").toBe("");
  });

  it("holds a message that arrives meanwhile hidden, or shown when it is the thread's", async () => {
    reduced = true;
    const { rerender } = render(<Harness />);
    fireEvent.click(kyotoLabels()[0]!);
    await settled();

    rerender(
      <Harness
        messages={[...chat, say("f3", "assistant", "f1", 6), say("k4", "assistant", "k1", 12)]}
      />,
    );

    expect(hidden()).toEqual(["f1", "f2", "f3", "free"]);
    expect(entry("k4")).toBeTruthy();
  });

  it("ends at once, with no motion, when another chat opens", async () => {
    reduced = true;
    const { rerender } = render(<Harness />);
    fireEvent.click(kyotoLabels()[0]!);
    await settled();
    expect(screen.getByTestId("focus").textContent).toBe("Kyoto trip");

    rerender(<Harness chatId="another" />);
    await settled();
    expect(screen.getByTestId("focus").textContent).toBe("");
  });
});

describe("pin", () => {
  // A scroller whose anchor sits `above` px of content under a blank of `top.style.height`.
  function world(scrollTop: number, above: number) {
    const state = { scrollTop, above };
    const top = { style: { height: "" } };
    const scroller = {
      get scrollTop() {
        return state.scrollTop;
      },
      set scrollTop(value: number) {
        state.scrollTop = Math.max(0, value);
      },
      getBoundingClientRect: () => ({ top: 0 }),
    };
    const anchor = {
      getBoundingClientRect: () => ({
        top: (Number.parseFloat(top.style.height) || 0) + state.above - state.scrollTop,
      }),
    };
    const env = { scroller, top } as unknown as Env;
    return { state, top, env, anchor: anchor as unknown as HTMLElement };
  }

  it("scrolls by what folded above the anchor, so it stays where it was", () => {
    const { state, top, env, anchor } = world(300, 500);
    const y = anchor.getBoundingClientRect().top;
    state.above = 400;
    pin(env, anchor, y);
    expect(anchor.getBoundingClientRect().top).toBe(y);
    expect(state.scrollTop).toBe(200);
    expect(top.style.height).toBe("");
  });

  it("keeps a blank above for what the scroll cannot absorb, and gives it back first when the content returns", () => {
    const { state, top, env, anchor } = world(40, 500);
    const y = anchor.getBoundingClientRect().top;
    state.above = 400;
    pin(env, anchor, y);
    expect(anchor.getBoundingClientRect().top).toBe(y);
    expect(state.scrollTop).toBe(0);
    expect(top.style.height).toBe("60px");

    state.above = 500;
    pin(env, anchor, y);
    expect(anchor.getBoundingClientRect().top).toBe(y);
    expect(top.style.height).toBe("");
    expect(state.scrollTop).toBe(40);
  });
});
