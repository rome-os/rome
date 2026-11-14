// @rstest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { type ReactNode, StrictMode } from "react";
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
import {
  ChatThreadView,
  chatThreadQueryKey,
  taskChatOfThread,
  useThreadTaskChat,
} from "./ChatThreadView";
import { ChatThreadsProvider } from "./reply/chat-threads";
import { QuotedReply } from "./reply/QuotedReply";
import { ReplyBar } from "./reply/ReplyBar";
import {
  ReplyDraftProvider,
  type ReplyDraft,
  type ReplyThread,
  useReplyDraftState,
} from "./reply/reply-draft";

// The thread view of a Concierge chat (docs/domains/chats.md#chat-thread):
// a thread label and a reply's quote open it in the tool pane, it reads one
// thread and follows it live, and it closes on Esc inside it.

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

/**
 * Holds the real draft of a chat that keeps chat threads, and hands it out.
 * With `thread`, it is the thread tab's draft; without, the chat's own.
 */
function ThreadsDraft({
  onDraft,
  onOpenThread = () => {},
  thread,
  children,
}: {
  onDraft: (draft: ReplyDraft) => void;
  onOpenThread?: (thread: ReplyThread) => void;
  thread?: string;
  children: ReactNode;
}) {
  const draft = useReplyDraftState({
    chatId: "concierge",
    sessionId: "concierge",
    messageIds: new Set(),
    jump: () => {},
    focusComposer: () => {},
    onOpenThread,
    thread,
  });
  onDraft(draft);
  return <ReplyDraftProvider value={draft}>{children}</ReplyDraftProvider>;
}

describe("the reply draft of a chat that keeps chat threads", () => {
  it("opens only the reply bar on Reply, even to a message in a thread", () => {
    let draft!: ReplyDraft;
    const open = rs.fn();
    render(
      <ThreadsDraft onDraft={(next) => (draft = next)} onOpenThread={open}>
        <ReplyBar />
      </ThreadsDraft>,
    );

    act(() => draft.set({ messageId: "a1", author: "agent", preview: "Which day?" }));

    expect(open).not.toHaveBeenCalled();
    expect(draft.thread).toBeNull();
    expect(draft.target?.messageId).toBe("a1");
    expect(document.querySelector("[data-reply-bar]")?.textContent).toContain("Which day?");
  });

  it("asks for the thread tab from a thread's label and leaves its own draft alone", () => {
    let draft!: ReplyDraft;
    const open = rs.fn();
    render(
      <ThreadsDraft onDraft={(next) => (draft = next)} onOpenThread={open}>
        <ReplyBar />
      </ThreadsDraft>,
    );

    act(() => draft.openThread({ thread: "a1", title: "Move my 3pm" }));

    expect(open).toHaveBeenCalledWith({ thread: "a1", title: "Move my 3pm" });
    // The chat's own composer keeps sending to the chat, with no reply bar.
    expect(draft.thread).toBeNull();
    expect(draft.target).toBeNull();
    expect(document.querySelector("[data-reply-bar]")).toBeNull();
  });

  it("drops a reply with its ✕, and keeps the thread tab's draft sending into its thread", () => {
    let draft!: ReplyDraft;
    render(
      <ThreadsDraft onDraft={(next) => (draft = next)} thread="a1">
        <ReplyBar />
      </ThreadsDraft>,
    );
    // A Reply inside the thread tab picks a reply in its own draft. "old" is
    // in the thread, but not in the timeline's loaded pages.
    act(() => draft.set({ messageId: "old", author: "guardian", preview: "Move my 3pm" }));
    expect(draft.target?.messageId).toBe("old");
    expect(draft.thread).toBe("a1");
    expect(document.querySelector("[data-reply-bar]")?.textContent).toContain("Move my 3pm");

    fireEvent.click(screen.getByRole("button", { name: "Cancel reply" }));

    expect(draft.target).toBeNull();
    expect(draft.thread).toBe("a1");
    expect(document.querySelector("[data-reply-bar]")).toBeNull();
  });

  it("opens the thread tab from the quote of a reply in a task's thread", () => {
    let draft!: ReplyDraft;
    const open = rs.fn();
    const part: ReplyToPart = {
      type: "reply_to",
      messageId: "a1",
      author: "agent",
      text: "Which day?",
    };
    render(
      <ThreadsDraft onDraft={(next) => (draft = next)} onOpenThread={open}>
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

    // The tab follows the reply, which is in the task's thread: the original
    // it quotes may be in none, as when the reply started the task.
    expect(open).toHaveBeenCalledWith({ thread: "r1", title: "Move my 3pm" });
    expect(draft.target).toBeNull();
  });

  it("jumps to the original from the quote of a reply in no task, and opens no thread tab", () => {
    const jump = rs.fn();
    const open = rs.fn();
    const part: ReplyToPart = {
      type: "reply_to",
      messageId: "a1",
      author: "agent",
      text: "Which day?",
    };
    function Draft({ children }: { children: ReactNode }) {
      const draft = useReplyDraftState({
        chatId: "concierge",
        sessionId: "concierge",
        messageIds: new Set(["a1"]),
        jump,
        focusComposer: () => {},
        onOpenThread: open,
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
    expect(open).not.toHaveBeenCalled();
  });

  it("jumps to the original from a quote inside the thread tab, which is open already", () => {
    const jump = rs.fn();
    const open = rs.fn();
    const part: ReplyToPart = {
      type: "reply_to",
      messageId: "a1",
      author: "agent",
      text: "Which day?",
    };
    function Draft({ children }: { children: ReactNode }) {
      const draft = useReplyDraftState({
        chatId: "concierge",
        sessionId: "concierge",
        messageIds: new Set(["a1"]),
        jump,
        focusComposer: () => {},
        onOpenThread: open,
        thread: "m1",
      });
      return <ReplyDraftProvider value={draft}>{children}</ReplyDraftProvider>;
    }
    // The thread tab's own transcript has no threads provider.
    render(
      <Draft>
        <QuotedReply part={part} hostId="r1" />
      </Draft>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Go to the original message" }));

    expect(jump).toHaveBeenCalledWith("a1");
    expect(open).not.toHaveBeenCalled();
  });

  it("puts a failed send's reply back only when nothing changed since the send", () => {
    let draft!: ReplyDraft;
    render(<ThreadsDraft onDraft={(next) => (draft = next)}>{null}</ThreadsDraft>);
    const a = { messageId: "a1", author: "agent" as const, preview: "Which day?" };
    const b = { messageId: "b1", author: "agent" as const, preview: "Which hotel?" };

    // Sent with reply A; the guardian picks B before A's send fails.
    act(() => draft.set(a));
    let sentAt = 0;
    act(() => {
      sentAt = draft.clear();
    });
    act(() => draft.set(b));
    act(() => draft.restore(a, sentAt));
    expect(draft.target?.messageId).toBe("b1");

    // B picked and dropped again: the draft stays empty.
    act(() => {
      sentAt = draft.clear();
    });
    act(() => draft.set(b));
    act(() => {
      draft.clear();
    });
    act(() => draft.restore(a, sentAt));
    expect(draft.target).toBeNull();

    // Nothing changed: A comes back.
    act(() => draft.set(a));
    act(() => {
      sentAt = draft.clear();
    });
    act(() => draft.restore(a, sentAt));
    expect(draft.target?.messageId).toBe("a1");
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
  const view = (props: Partial<Parameters<typeof ChatThreadView>[0]> = {}) => (
    <ChatThreadView
      sessionId="concierge"
      messageId="a1"
      onClose={() => {}}
      renderMessages={paragraphs}
      {...props}
    />
  );

  it("shows the thread's messages and new ones as they are said", async () => {
    render(host(view()));

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

  it("is a panel in the flow, with no overlay or backdrop over the chat", async () => {
    render(host(view()));
    await screen.findByText("Which day?");
    const panel = screen.getByRole("region", { name: "Chat thread" });
    expect(panel.className).not.toMatch(/absolute|inset-0|z-\d/);
    expect(panel.querySelector("[aria-hidden]")).toBeNull();
    // No header of its own: the pane's tab names the thread and closes it.
    expect(panel.querySelector("button")).toBeNull();
    expect(panel.querySelector("[class*=backdrop]")).toBeNull();
    // Blend modes in a message stay inside the list.
    const list = screen.getByText("Which day?").closest("div.isolate");
    expect(list).toBeTruthy();
  });

  it("draws the composer it is given below its messages", async () => {
    render(host(view({ composer: <textarea aria-label="reply" /> })));
    const message = await screen.findByText("Which day?");
    const composer = screen.getByLabelText("reply");
    expect(
      message.compareDocumentPosition(composer) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("closes on Esc inside it, unless the focused control used the key", async () => {
    const onClose = rs.fn();
    render(
      host(
        <div>
          <textarea aria-label="main composer" />
          {view({
            onClose,
            composer: (
              <>
                <textarea aria-label="reply" />
                <input
                  aria-label="menu"
                  onKeyDown={(event) => event.key === "Escape" && event.preventDefault()}
                />
              </>
            ),
          })}
        </div>,
      ),
    );
    await screen.findByText("Which day?");

    // The chat's own composer is outside it: Esc there leaves the thread alone.
    fireEvent.keyDown(screen.getByLabelText("main composer"), { key: "Escape" });
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    // A control that used the key first, as a reply bar's Esc does.
    fireEvent.keyDown(screen.getByLabelText("menu"), { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.keyDown(screen.getByLabelText("reply"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("stays open on a press anywhere in or around it", async () => {
    const onClose = rs.fn();
    render(
      host(
        <div>
          <nav>sidebar</nav>
          {view({ onClose })}
        </div>,
      ),
    );
    await screen.findByText("Which day?");

    fireEvent.pointerDown(screen.getByText("Which day?"));
    fireEvent.pointerDown(screen.getByText("sidebar"));
    fireEvent.pointerDown(screen.getByRole("region", { name: "Chat thread" }));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("tints the message it opened from, then lets it go", async () => {
    render(host(view()));
    const copy = (await screen.findByText("Which day?")).closest("[data-timeline-anchor]")!;
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
    render(host(view({ renderMessages: bubbles })));
    const first = (await screen.findByText("Which day?")).closest("[data-message-part]")!;
    const later = screen.getByText("Which day? (more)");
    await waitFor(() => expect(first.hasAttribute("data-timeline-landed")).toBe(true));
    expect(later.hasAttribute("data-timeline-landed")).toBe(true);
  });

  it("tints the message again each time its thread opens, from the cache under StrictMode too", async () => {
    // The dashboard runs under StrictMode, which runs a view's effects twice
    // on mount; a reopened thread draws its cached messages at once.
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const tree = (open: boolean) => (
      <StrictMode>
        <QueryClientProvider client={client}>
          <LiveEventsClientContext.Provider value={fakeSocketLiveEventsClient()}>
            {open ? view() : null}
          </LiveEventsClientContext.Provider>
        </QueryClientProvider>
      </StrictMode>
    );
    const opensWithTint = async () => {
      const copy = (await screen.findByText("Which day?")).closest("[data-timeline-anchor]")!;
      await waitFor(() => expect(copy.hasAttribute("data-timeline-landed")).toBe(true));
    };
    const { rerender } = render(tree(true));
    await opensWithTint();
    rerender(tree(false));
    expect(screen.queryByText("Which day?")).toBeNull();
    rerender(tree(true));
    await opensWithTint();
  });

  describe("following the newest message", () => {
    const scrolled: number[] = [];
    beforeEach(() => {
      scrolled.length = 0;
      // The list's content is 1000px tall in a 400px view.
      rs.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(1000);
      rs.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(400);
      rs.spyOn(HTMLElement.prototype, "scrollTop", "get").mockReturnValue(600);
      rs.spyOn(HTMLElement.prototype, "scrollTop", "set").mockImplementation((value: number) => {
        scrolled.push(value);
      });
    });
    afterEach(() => rs.restoreAllMocks());

    const arrives = async () => {
      const socket = acceptLatestSocket();
      thread = [...thread, message("m2", "user", "Make it tomorrow instead")];
      act(() =>
        socket.receive({
          type: "event",
          topic: chatSessionTopicName("concierge"),
          event: "message_insert",
          data: { sessionId: "concierge", messageId: "m2" },
        }),
      );
      await screen.findByText("Make it tomorrow instead");
    };

    it("keeps it at the bottom, in view, as messages arrive", async () => {
      render(host(view()));
      await screen.findByText("Which day?");
      await waitFor(() => expect(scrolled.at(-1)).toBe(1000));
      scrolled.length = 0;
      await arrives();
      expect(scrolled.at(-1)).toBe(1000);
    });

    it("leaves a reader who scrolled up where they are", async () => {
      render(host(view()));
      await screen.findByText("Which day?");
      // 600 + 400 = 1000: at the bottom. Scrolled up is 200 + 400 < 1000.
      rs.spyOn(HTMLElement.prototype, "scrollTop", "get").mockReturnValue(200);
      fireEvent.scroll(screen.getByText("Which day?").closest("div.isolate")!);
      scrolled.length = 0;
      await arrives();
      expect(scrolled).toEqual([]);
    });
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

  it("takes the task chat Rome names on a thread with no card in it", () => {
    const messages = [
      said("root", [{ type: "text", text: "Looking into it." }], null),
      {
        ...(said("reply", [{ type: "text", text: "Done." }]) as object),
        chatThreadTaskChatId: "named-chat",
      } as never,
    ];
    expect(taskChatOfThread(messages, "root")).toBe("named-chat");
  });
});

describe("useThreadTaskChat", () => {
  const card = (id: string, chatId: string) =>
    ({
      id,
      sessionId: "concierge",
      role: "assistant",
      content: JSON.stringify([{ type: "task_chat", chatId, title: "A", show: "ask" }]),
      createdAt: "2026-11-10T12:00:00Z",
      chatThreadId: "root",
    }) as never;
  const open = { sessionId: "concierge", messageId: "a1", threadRoot: "root" };
  const hook = (
    thread: typeof open | null,
    options: Parameters<typeof useThreadTaskChat>[1],
    client = new QueryClient(),
  ) =>
    renderHook(() => useThreadTaskChat(thread, options), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    });

  it("is null with no thread open", () => {
    expect(hook(null, { messages: [card("c", "task-chat")] }).result.current).toBeNull();
  });

  it("reads the task chat from the chat's loaded messages, and a live placement first", () => {
    expect(hook(open, { messages: [card("c", "task-chat")] }).result.current).toBe("task-chat");
    expect(
      hook(open, { messages: [card("c", "task-chat")], liveTaskChat: "live-chat" }).result.current,
    ).toBe("live-chat");
  });

  it("reads it from the thread the view loaded, shared through the cache", () => {
    const client = new QueryClient();
    client.setQueryData(chatThreadQueryKey("concierge", "a1"), [card("c", "from-view")]);
    expect(hook(open, { messages: [] }, client).result.current).toBe("from-view");
  });
});
