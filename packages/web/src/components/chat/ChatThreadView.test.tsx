// @rstest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
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
import userEvent from "@testing-library/user-event";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ChatThreadView, KEEPS_CHAT_THREAD_OPEN } from "./ChatThreadView";
import { QuotedReply } from "./reply/QuotedReply";
import { ReplyDraftProvider, useReplyDraftState, type ReplyDraft } from "./reply/reply-draft";

// The thread view of a Concierge chat (docs/domains/chats.md#chat-thread):
// Reply and a reply's quote open it, it reads one thread and follows it live,
// and it closes on Esc or a click outside it and the composer.

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
  });
});

describe("ChatThreadView", () => {
  it("shows the thread's messages and new ones as they are said", async () => {
    render(host(<ChatThreadView sessionId="concierge" messageId="a1" onClose={() => {}} />));

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

  it("stays open through a menu the composer opens, which renders outside the app's tree", async () => {
    const onClose = rs.fn();
    const picked = rs.fn();
    render(
      host(
        <div>
          <div {...{ [KEEPS_CHAT_THREAD_OPEN]: "" }}>
            <DropdownMenu>
              <DropdownMenuTrigger>Attach</DropdownMenuTrigger>
              <DropdownMenuContent>
                <DropdownMenuItem onSelect={picked}>From a project</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          <ChatThreadView sessionId="concierge" messageId="a1" onClose={onClose} />
        </div>,
      ),
    );
    await screen.findByText("Which day?");

    await userEvent.click(screen.getByRole("button", { name: "Attach" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "From a project" }));

    expect(picked).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("closes on Esc and on a click outside, but not on a click in the composer", async () => {
    const onClose = rs.fn();
    render(
      host(
        <div>
          <p>transcript</p>
          <div {...{ [KEEPS_CHAT_THREAD_OPEN]: "" }}>
            <textarea aria-label="composer" />
          </div>
          <ChatThreadView sessionId="concierge" messageId="a1" onClose={onClose} />
        </div>,
      ),
    );
    await screen.findByText("Which day?");

    fireEvent.pointerDown(screen.getByLabelText("composer"));
    fireEvent.pointerDown(screen.getByText("Which day?"));
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.pointerDown(screen.getByText("transcript"));
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(2));
  });
});
