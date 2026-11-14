// @rstest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, rs } from "@rstest/core";
import i18n from "@/i18n";
import { clearAllChatDrafts } from "@/lib/chat-draft-storage";
import { invalidateNewChatDrafts } from "@/lib/new-chat-draft-storage";
import { ChatComposer } from "../ChatComposer";
import { ConciergeComposer } from "./ConciergeComposer";
import { ReplyDraftHarness } from "../reply/reply-draft-harness";

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

beforeEach(() => {
  localStorage.clear();
  rs.spyOn(globalThis, "fetch").mockImplementation((async () =>
    Response.json({}, { status: 404 })) as typeof fetch);
});

afterEach(() => {
  cleanup();
  rs.restoreAllMocks();
});

const composers = {
  chat: (chatId: string, onSend: () => void) => <ChatComposer chatId={chatId} onSend={onSend} />,
  concierge: (chatId: string, onSend: () => void) => (
    <ReplyDraftHarness>
      <ConciergeComposer chatId={chatId} onSend={onSend} />
    </ReplyDraftHarness>
  ),
};

/** Opens the chat's message field, as navigating to the chat or reloading does. */
function openChat(kind: keyof typeof composers, chatId: string) {
  const onSend = rs.fn(async () => {});
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <MemoryRouter>
      <QueryClientProvider client={client}>{composers[kind](chatId, onSend)}</QueryClientProvider>
    </MemoryRouter>,
  );
  const field = () => view.container.querySelector("form textarea") as HTMLTextAreaElement;
  const type = (text: string) => fireEvent.change(field(), { target: { value: text } });
  return { onSend, field, type, leave: view.unmount };
}

describe.each(["chat", "concierge"] as const)("the %s message field's draft", (kind) => {
  it("comes back after leaving the chat or reloading the page", () => {
    const first = openChat(kind, "chat-a");
    first.type("half a thought");
    first.leave();

    expect(openChat(kind, "chat-a").field().value).toBe("half a thought");
  });

  it("belongs to one chat", () => {
    const a = openChat(kind, "chat-a");
    a.type("for a");
    a.leave();

    expect(openChat(kind, "chat-b").field().value).toBe("");
  });

  it("is gone once the message is sent", async () => {
    const first = openChat(kind, "chat-a");
    first.type("send me");
    fireEvent.keyDown(first.field(), { key: "Enter" });
    await waitFor(() => expect(first.onSend).toHaveBeenCalled());
    first.leave();

    expect(openChat(kind, "chat-a").field().value).toBe("");
  });

  it("is gone after logging out", () => {
    const first = openChat(kind, "chat-a");
    first.type("private");
    first.leave();
    invalidateNewChatDrafts();
    clearAllChatDrafts();

    expect(openChat(kind, "chat-a").field().value).toBe("");
  });
});
