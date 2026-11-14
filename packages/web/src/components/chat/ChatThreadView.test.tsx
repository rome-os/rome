// @rstest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { type ReactNode, StrictMode } from "react";
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
import { ChatThreadView, chatThreadQueryKey, taskChatOfThread } from "./ChatThreadView";
import { ConciergeTranscript } from "./ConciergeTranscript";
import { buildRows } from "./chat-view";
import type { BlockActions } from "./MessageList";
import { ChatThreadsProvider } from "./reply/chat-threads";
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
  it("opens only the reply bar on Reply, even to a message in a thread", () => {
    let draft!: ReplyDraft;
    render(
      <ThreadsDraft onDraft={(next) => (draft = next)}>
        <ReplyBar />
      </ThreadsDraft>,
    );

    act(() => draft.set({ messageId: "a1", author: "agent", preview: "Which day?" }));

    expect(draft.thread).toBeNull();
    expect(draft.target?.messageId).toBe("a1");
    expect(document.querySelector("[data-reply-bar]")?.textContent).toContain("Which day?");
  });

  it("opens the thread view from its label with a reply to the thread, and closing it clears it", () => {
    let draft!: ReplyDraft;
    render(
      <ThreadsDraft onDraft={(next) => (draft = next)}>
        <ReplyBar />
      </ThreadsDraft>,
    );

    act(() => draft.openThread({ thread: "a1", title: "Move my 3pm" }));
    expect(draft.thread).toBe("a1");
    // The reply goes to the thread: no message quoted.
    expect(draft.target).toBeNull();
    expect(document.querySelector("[data-reply-bar]")?.textContent).toBe("Reply to Move my 3pm");

    act(() => draft.closeThread());
    expect(draft.thread).toBeNull();
    expect(draft.target).toBeNull();
  });

  it("keeps the timeline on Reply to a message in no thread, with the quote bar on the main composer", () => {
    let draft!: ReplyDraft;
    render(
      <ThreadsDraft onDraft={(next) => (draft = next)}>
        <ReplyBar />
      </ThreadsDraft>,
    );

    act(() => draft.set({ messageId: "a9", author: "agent", preview: "168" }));

    expect(draft.thread).toBeNull();
    expect(draft.target?.messageId).toBe("a9");
    expect(document.querySelector("[data-reply-bar]")?.textContent).toContain("168");
    // Its ✕ drops the reply.
    fireEvent.click(screen.getByRole("button", { name: "Cancel reply" }));
    expect(draft.target).toBeNull();
  });

  it("keeps the thread view and its reply to the thread on Reply inside it", () => {
    let draft!: ReplyDraft;
    render(<ThreadsDraft onDraft={(next) => (draft = next)}>{null}</ThreadsDraft>);
    act(() => draft.openThread({ thread: "a1", title: "Move my 3pm" }));
    // "old" is in the open thread, but not in the timeline's loaded pages.
    act(() => draft.set({ messageId: "old", author: "guardian", preview: "Move my 3pm" }));

    // A Reply inside the view keeps the reply to the thread.
    expect(draft.thread).toBe("a1");
    expect(draft.target).toBeNull();
  });

  it("opens the thread view from the quote of a reply in a task's thread", () => {
    let draft!: ReplyDraft;
    const part: ReplyToPart = {
      type: "reply_to",
      messageId: "a1",
      author: "agent",
      text: "Which day?",
    };
    render(
      <ThreadsDraft onDraft={(next) => (draft = next)}>
        <ChatThreadsProvider
          value={{
            labels: new Map(),
            taskThreads: new Map([["r1", "m1"]]),
            titles: new Map([["m1", "Move my 3pm"]]),
          }}
        >
          <QuotedReply part={part} hostId="r1" />
        </ChatThreadsProvider>
      </ThreadsDraft>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Open the chat thread" }));

    // The view, and what is sent from it, follow the reply, which is in the
    // task's thread: the original it quotes may be in none, as when the reply
    // started the task.
    expect(draft.thread).toBe("r1");
    // The reply goes to the task's thread, named by its title, quoting no message.
    expect(draft.target).toBeNull();
    expect(draft.threadTitle).toBe("Move my 3pm");
  });

  it("jumps to the original from the quote of a reply in no task, and opens no thread view", () => {
    let draft!: ReplyDraft;
    const jump = rs.fn();
    const part: ReplyToPart = {
      type: "reply_to",
      messageId: "a1",
      author: "agent",
      text: "Which day?",
    };
    function Draft({ children }: { children: ReactNode }) {
      draft = useReplyDraftState({
        chatId: "concierge",
        sessionId: "concierge",
        messageIds: new Set(["a1"]),
        jump,
        focusComposer: () => {},
        threads: true,
      });
      return <ReplyDraftProvider value={draft}>{children}</ReplyDraftProvider>;
    }
    render(
      <Draft>
        <ChatThreadsProvider value={{ labels: new Map(), taskThreads: new Map() }}>
          <QuotedReply part={part} hostId="r1" />
        </ChatThreadsProvider>
      </Draft>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Go to the original message" }));

    expect(jump).toHaveBeenCalledWith("a1");
    expect(draft.thread).toBeNull();
  });

  it("puts a failed send's reply and thread back only when nothing changed since the send", () => {
    let draft!: ReplyDraft;
    render(<ThreadsDraft onDraft={(next) => (draft = next)}>{null}</ThreadsDraft>);
    const a = { thread: "a1", title: "Flights" };
    const b = { thread: "b1", title: "Hotels" };
    const reply = { messageId: "a1", author: "agent" as const, preview: "Which day?" };

    // Sent from thread A; the guardian opens B before A's send fails.
    act(() => draft.openThread(a));
    let sentAt = 0;
    act(() => {
      sentAt = draft.clear();
    });
    act(() => draft.openThread(b));
    act(() => draft.restore({ thread: a }, sentAt));
    expect([draft.thread, draft.threadTitle]).toEqual(["b1", "Hotels"]);

    // B opened and closed again: the draft stays closed.
    act(() => {
      sentAt = draft.clear();
    });
    act(() => draft.openThread(b));
    act(() => {
      draft.clear();
    });
    act(() => draft.restore({ thread: a }, sentAt));
    expect([draft.target, draft.thread]).toEqual([null, null]);

    // Nothing changed: A's thread comes back.
    act(() => draft.openThread(a));
    act(() => {
      sentAt = draft.clear();
    });
    act(() => draft.restore({ thread: a }, sentAt));
    expect([draft.target, draft.thread, draft.threadTitle]).toEqual([null, "a1", "Flights"]);

    // A reply sent from the timeline comes back with the reply bar alone.
    act(() => draft.clear());
    act(() => draft.set(reply));
    act(() => {
      sentAt = draft.clear();
    });
    act(() => draft.restore({ target: reply }, sentAt));
    expect([draft.target?.messageId, draft.thread]).toEqual(["a1", null]);
  });

  it("keeps the reply bar at every width while the thread is open, and closes the thread with its ✕", () => {
    let draft!: ReplyDraft;
    const { container } = render(
      <ThreadsDraft onDraft={(next) => (draft = next)}>
        <ReplyBar />
      </ThreadsDraft>,
    );
    act(() => draft.openThread({ thread: "a1", title: "Move my 3pm" }));
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

  it("covers the chat behind with a near-opaque backdrop and keeps blend modes inside the list", async () => {
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
    await screen.findByText("Which day?");
    const view = screen.getByRole("dialog", { name: "Chat thread" });
    const [backdrop, list] = view.querySelectorAll<HTMLElement>("[data-chat-thread-fade]");
    // Readable without the blur: an avatar's blend ring once cut it off.
    expect(backdrop?.className).toContain("bg-chat-canvas/95");
    expect(backdrop?.className).not.toMatch(/supports-\[backdrop-filter\]/);
    expect(list?.className.split(" ")).toContain("isolate");
  });

  it("tints the message it opened from once it has faded in, then lets it go", async () => {
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
    const copy = (await screen.findByText("Which day?")).closest("[data-timeline-anchor]")!;
    expect(copy.hasAttribute("data-timeline-landed")).toBe(false);
    await waitFor(() => expect(copy.hasAttribute("data-timeline-landed")).toBe(true));
    await waitFor(() => expect(copy.hasAttribute("data-timeline-landed")).toBe(false), {
      timeout: 2000,
    });
  });

  it("tints every bubble of the message it opened from, not only its first", async () => {
    // Each bubble of a message after its first names the message as its own.
    const bubbles = (messages: { id: string; content: string }[]) =>
      messages.flatMap((m) =>
        (JSON.parse(m.content) as { content: string }[]).map((part, index) => (
          <p
            key={`${m.id}:${index}`}
            data-timeline-anchor={index === 0 ? m.id : undefined}
            data-message-part={m.id}
          >
            {index === 0 ? part.content : `${part.content} (more)`}
          </p>
        )),
      );
    thread = [
      message("m1", "user", "Move my 3pm"),
      {
        ...message("a1", "assistant", "Which day?"),
        content: JSON.stringify([
          { type: "text", content: "Which day?" },
          { type: "text", content: "Which day?" },
        ]),
      },
    ];
    render(
      host(
        <ChatThreadView
          sessionId="concierge"
          messageId="a1"
          onClose={() => {}}
          renderMessages={bubbles}
        />,
      ),
    );
    const first = (await screen.findByText("Which day?")).closest("[data-message-part]")!;
    const later = screen.getByText("Which day? (more)");
    await waitFor(() => expect(first.hasAttribute("data-timeline-landed")).toBe(true));
    expect(later.hasAttribute("data-timeline-landed")).toBe(true);
  });

  it("tints the message again each time its thread opens, from the cache under StrictMode too", async () => {
    // The dashboard runs under StrictMode, which runs a view's effects twice
    // on mount; a reopened thread draws its cached messages at once.
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = (open: boolean) => (
      <StrictMode>
        <QueryClientProvider client={client}>
          <LiveEventsClientContext.Provider value={fakeSocketLiveEventsClient()}>
            {open ? (
              <ChatThreadView
                key="a1"
                sessionId="concierge"
                messageId="a1"
                onClose={() => {}}
                renderMessages={paragraphs}
              />
            ) : null}
          </LiveEventsClientContext.Provider>
        </QueryClientProvider>
      </StrictMode>
    );
    const opensWithTint = async () => {
      const copy = (await screen.findByText("Which day?")).closest("[data-timeline-anchor]")!;
      await waitFor(() => expect(copy.hasAttribute("data-timeline-landed")).toBe(true));
    };
    const { rerender } = render(view(true));
    await opensWithTint();
    rerender(view(false));
    expect(screen.queryByText("Which day?")).toBeNull();
    rerender(view(true));
    await opensWithTint();
  });

  it("reads where the message it opened from sat once, on open", async () => {
    const originTop = rs.fn(() => 320);
    const { rerender } = render(
      host(
        <ChatThreadView
          sessionId="concierge"
          messageId="a1"
          onClose={() => {}}
          originTop={originTop}
          renderMessages={paragraphs}
        />,
      ),
    );
    await screen.findByText("Which day?");
    rerender(
      host(
        <ChatThreadView
          sessionId="concierge"
          messageId="a1"
          onClose={() => {}}
          originTop={originTop}
          renderMessages={paragraphs}
        />,
      ),
    );
    expect(originTop).toHaveBeenCalledTimes(1);
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

describe("taskChatOfThread", () => {
  const said = (id: string, parts: unknown[], chatThreadId: string | null = "root") =>
    ({
      id,
      sessionId: "concierge",
      role: "assistant",
      content: JSON.stringify(parts),
      createdAt: "2026-11-10T12:00:00Z",
      chatThreadId,
    }) as never;

  it("takes the task chat a card in the thread names, with no task list", () => {
    const messages = [
      said("other", [{ type: "task_chat", chatId: "elsewhere", title: "B" }], "other-root"),
      said("root", [{ type: "text", text: "On it." }], null),
      said("card", [{ type: "task_chat", chatId: "task-chat", title: "A", show: "ask" }]),
    ];
    expect(taskChatOfThread(messages, "root")).toBe("task-chat");
    expect(taskChatOfThread(messages, "no-thread")).toBeNull();
  });
});
