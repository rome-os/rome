// @rstest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import type { ReplyToPart } from "@rome/api-types/chat";
import { chatSessionTopicName } from "@rome/api-types/live-events";
import i18n from "@/i18n";
import { LiveEventsClientContext } from "@/hooks/use-live-events";
import { ThemeProvider } from "@/hooks/use-theme";
import {
  acceptLatestSocket,
  FakeWebSocket,
  fakeSocketLiveEventsClient,
} from "@/test/fake-websocket";
import { MemoryRouter } from "react-router-dom";
import { EMPTY_LIVE_TEXT } from "@/hooks/live-text";
import { ChatThreadView, chatThreadQueryKey } from "./ChatThreadView";
import { ConciergeTranscript } from "./ConciergeTranscript";
import { buildRows } from "./chat-view";
import type { BlockActions } from "./MessageList";
import { QuotedReply } from "./reply/QuotedReply";
import { ReplyBar } from "./reply/ReplyBar";
import { ReplyDraftProvider, useReplyDraftState, type ReplyDraft } from "./reply/reply-draft";

// The thread view of a Concierge chat (docs/domains/chats.md#chat-thread):
// Reply and a reply's quote open it, it reads one thread and follows it live,
// and it closes on Esc or a press on its blurred area.

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

const message = (id: string, role: "user" | "assistant", text: string) => ({
  id,
  sessionId: "concierge",
  turnId: null,
  role,
  content: JSON.stringify([{ type: "text", content: text }]),
  createdAt: new Date(2026, 10, 9).toISOString(),
  chatThreadId: "m1",
});

let thread: ReturnType<typeof message>[];
const requested: string[] = [];

beforeEach(() => {
  FakeWebSocket.instances = [];
  requested.length = 0;
  thread = [message("m1", "user", "Move my 3pm"), message("a1", "assistant", "Which day?")];
  rs.stubGlobal(
    "fetch",
    rs.fn(async (url: string) => {
      requested.push(url);
      return new Response(JSON.stringify({ messages: thread, nextCursor: null }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
});
afterEach(() => {
  cleanup();
  rs.unstubAllGlobals();
});

function host(children: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={client}>
      <LiveEventsClientContext.Provider value={fakeSocketLiveEventsClient()}>
        <ThemeProvider>{children}</ThemeProvider>
      </LiveEventsClientContext.Provider>
    </QueryClientProvider>
  );
}

/** Holds the real draft of a chat that keeps chat threads, and hands it out. */
function ThreadsDraft({
  onDraft,
  children,
}: {
  onDraft: (draft: ReplyDraft) => void;
  children: ReactNode;
}) {
  const draft = useReplyDraftState({
    chatId: "concierge",
    sessionId: "concierge",
    messageIds: new Set(),
    jump: () => {},
    focusComposer: () => {},
    threads: true,
  });
  onDraft(draft);
  return <ReplyDraftProvider value={draft}>{children}</ReplyDraftProvider>;
}

describe("the reply draft of a chat that keeps chat threads", () => {
  it("opens the thread view on Reply, and closing it clears the reply", () => {
    let draft!: ReplyDraft;
    render(<ThreadsDraft onDraft={(next) => (draft = next)}>{null}</ThreadsDraft>);

    act(() => draft.set({ messageId: "a1", author: "agent", preview: "Which day?" }));
    expect(draft.thread).toBe("a1");
    expect(draft.target?.messageId).toBe("a1");

    act(() => draft.closeThread());
    expect(draft.thread).toBeNull();
    expect(draft.target).toBeNull();
  });

  it("opens the thread view from a reply's quote", () => {
    let draft!: ReplyDraft;
    const part: ReplyToPart = {
      type: "reply_to",
      messageId: "a1",
      author: "agent",
      text: "Which day?",
    };
    render(
      <ThreadsDraft onDraft={(next) => (draft = next)}>
        <QuotedReply part={part} />
      </ThreadsDraft>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Open the chat thread" }));

    expect(draft.thread).toBe("a1");
    // Opening either opens both: the quote also picks the reply.
    expect(draft.target).toMatchObject({ messageId: "a1", preview: "Which day?" });
  });

  it("puts a failed send's reply and thread back only when nothing changed since the send", () => {
    let draft!: ReplyDraft;
    render(<ThreadsDraft onDraft={(next) => (draft = next)}>{null}</ThreadsDraft>);
    const a = { messageId: "a1", author: "agent" as const, preview: "Which day?" };
    const b = { messageId: "b1", author: "agent" as const, preview: "Flights?" };

    // Sent from thread A; the guardian picks B before A's send fails.
    act(() => draft.set(a));
    let sentAt = 0;
    act(() => {
      sentAt = draft.clear();
    });
    act(() => draft.set(b));
    act(() => draft.restore(a, sentAt));
    expect([draft.target?.messageId, draft.thread]).toEqual(["b1", "b1"]);

    // B picked and dropped again: the draft stays closed.
    act(() => {
      sentAt = draft.clear();
    });
    act(() => draft.set(b));
    act(() => {
      draft.clear();
    });
    act(() => draft.restore(a, sentAt));
    expect([draft.target, draft.thread]).toEqual([null, null]);

    // Nothing changed: A comes back with its thread.
    act(() => draft.set(a));
    act(() => {
      sentAt = draft.clear();
    });
    act(() => draft.restore(a, sentAt));
    expect([draft.target?.messageId, draft.thread]).toEqual(["a1", "a1"]);
  });

  it("keeps the reply bar at every width while the thread is open, and closes the thread with its ✕", () => {
    let draft!: ReplyDraft;
    const { container } = render(
      <ThreadsDraft onDraft={(next) => (draft = next)}>
        <ReplyBar />
      </ThreadsDraft>,
    );
    act(() => draft.set({ messageId: "a1", author: "agent", preview: "Which day?" }));
    expect(draft.thread).toBe("a1");
    // The phone width is the same dashboard: no class hides the bar there.
    expect(container.querySelector("[data-reply-bar]")!.className).not.toMatch(/hidden/);

    fireEvent.click(screen.getByRole("button", { name: "Cancel reply" }));

    expect(draft.target).toBeNull();
    expect(draft.thread).toBeNull();
  });
});

/** Draws each message as one paragraph of its first text, as a stand-in for the transcript. */
const paragraphs = (messages: { id: string; content: string }[]) =>
  messages.map((m) => (
    <p key={m.id} data-timeline-anchor={m.id}>
      {(JSON.parse(m.content) as { content: string }[])[0].content}
    </p>
  ));

describe("ChatThreadView", () => {
  it("shows the thread's messages and new ones as they are said", async () => {
    render(
      host(
        <ChatThreadView
          sessionId="concierge"
          messageId="a1"
          onClose={() => {}}
          renderMessages={paragraphs}
        />,
      ),
    );

    expect(await screen.findByText("Which day?")).toBeTruthy();
    expect(requested[0]).toBe("/api/chat/sessions/concierge/messages?thread=a1");

    const socket = acceptLatestSocket();
    thread = [...thread, message("m2", "user", "Make it tomorrow instead")];
    act(() =>
      socket.receive({
        type: "event",
        topic: chatSessionTopicName("concierge"),
        event: "message_chat_thread",
        data: { sessionId: "concierge", messageId: "m2", chatThreadId: "m1" },
      }),
    );

    expect(await screen.findByText("Make it tomorrow instead")).toBeTruthy();
  });

  it("floats the header it is given over its messages", async () => {
    render(
      host(
        <ChatThreadView
          sessionId="concierge"
          messageId="a1"
          onClose={() => {}}
          header={<header>Milo</header>}
          renderMessages={paragraphs}
        />,
      ),
    );
    const view = await screen.findByRole("dialog", { name: "Chat thread" });
    expect(view.className).toContain("absolute");
    expect(view.className).toContain("inset-0");
    expect(screen.getByText("Milo")).toBeTruthy();
    // No title of its own.
    expect(screen.queryByText(/repl(y|ies)/)).toBeNull();
  });

  it("keeps open on a press on any bubble of a message, a forwarded report included", async () => {
    rs.stubGlobal("IntersectionObserver", undefined);
    rs.stubGlobal(
      "matchMedia",
      rs.fn((query: string) => ({
        matches: false,
        media: query,
        addEventListener: rs.fn(),
        removeEventListener: rs.fn(),
      })),
    );
    thread = [
      {
        ...message("a1", "assistant", "x"),
        turnId: "t1",
        content: JSON.stringify([
          { type: "text", content: "Here it is" },
          {
            type: "text",
            content: "# Report\n\nThree hotels near the river.",
            format: "long",
            forwardedFrom: { chatId: "task-1", title: "Hotels" },
          },
        ]),
      },
    ];
    const onClose = rs.fn();
    const identity = { name: "Rome", iconUrl: null };
    render(
      host(
        <MemoryRouter>
          <ChatThreadView
            sessionId="concierge"
            messageId="a1"
            onClose={onClose}
            renderMessages={(messages) => (
              <ConciergeTranscript
                rows={buildRows(messages, new Map(), identity, {
                  runningTurnId: null,
                  isStreaming: false,
                })}
                live={{
                  isStreaming: false,
                  runningTurnId: null,
                  snapshot: null,
                  textStore: EMPTY_LIVE_TEXT,
                  identity,
                }}
                actions={
                  {
                    onApprovalResolved: () => {},
                    onSubmitAppComponent: () => {},
                    onDismissAppComponent: () => {},
                    interactionResults: new Map(),
                  } as BlockActions
                }
                contentRef={() => {}}
              />
            )}
          />
        </MemoryRouter>,
      ),
    );
    const report = await screen.findByText("Three hotels near the river.");
    // Nothing stops the press, so a drag from it still selects text.
    expect(fireEvent.pointerDown(report)).toBe(true);
    fireEvent.pointerDown(screen.getByText("Here it is"));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.pointerDown(screen.getByRole("dialog", { name: "Chat thread" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes on Esc and on a press on its blurred area, not on a message or outside it", async () => {
    const onClose = rs.fn();
    render(
      host(
        <div>
          <nav>sidebar</nav>
          <textarea aria-label="composer" />
          <ChatThreadView
            sessionId="concierge"
            messageId="a1"
            onClose={onClose}
            renderMessages={paragraphs}
          />
        </div>,
      ),
    );
    await screen.findByText("Which day?");

    fireEvent.pointerDown(screen.getByText("Which day?"));
    fireEvent.pointerDown(screen.getByText("sidebar"));
    fireEvent.pointerDown(screen.getByLabelText("composer"));
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.pointerDown(screen.getByRole("dialog", { name: "Chat thread" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(2));
  });

  it("stays open on a press inside a layer its content opened in a portal", async () => {
    const onClose = rs.fn();
    render(
      host(
        <ChatThreadView
          sessionId="concierge"
          messageId="a1"
          onClose={onClose}
          renderMessages={(messages) => (
            <>
              {paragraphs(messages)}
              {createPortal(<div>popover padding</div>, document.body)}
            </>
          )}
        />,
      ),
    );
    await screen.findByText("Which day?");
    fireEvent.pointerDown(screen.getByText("popover padding"));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("puts a cached thread's newest message above the composer once its floor is measured", async () => {
    // A list's content is 1000px tall, plus the floor it keeps clear of.
    const tops: number[] = [];
    rs.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function (
      this: HTMLElement,
    ) {
      return 1000 + (Number.parseFloat(this.style.paddingBottom) || 0);
    });
    rs.spyOn(HTMLElement.prototype, "scrollTop", "set").mockImplementation((value: number) => {
      tops.push(value);
    });
    const floor = document.createElement("div");
    floor.getBoundingClientRect = () => ({ height: 150 }) as DOMRect;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    // Opened before: its messages are drawn at once, before the floor is measured.
    client.setQueryData(chatThreadQueryKey("concierge", "a1"), thread);
    render(
      <QueryClientProvider client={client}>
        <LiveEventsClientContext.Provider value={fakeSocketLiveEventsClient()}>
          <ChatThreadView
            sessionId="concierge"
            messageId="a1"
            onClose={() => {}}
            floor={floor}
            renderMessages={paragraphs}
          />
        </LiveEventsClientContext.Provider>
      </QueryClientProvider>,
    );
    await screen.findByText("Which day?");
    await waitFor(() => expect(tops.at(-1)).toBe(1150));
    rs.restoreAllMocks();
  });
});
