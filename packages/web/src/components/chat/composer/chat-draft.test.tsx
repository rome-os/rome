// @rstest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { createRef, type Ref } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, rs } from "@rstest/core";
import i18n from "@/i18n";
import { deleteSession } from "@/lib/chat-api";
import {
  clearAllChatDrafts,
  loadChatDraft,
  restoreUnsentChatDraft,
  saveChatDraft,
} from "@/lib/chat-draft-storage";
import { currentAuthEpoch, invalidateNewChatDrafts } from "@/lib/new-chat-draft-storage";
import { ChatComposer, type ChatComposerHandle } from "../ChatComposer";
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

type OnSend = () => Promise<void>;
const composers = {
  chat: (chatId: string | null, onSend: OnSend, ref: Ref<ChatComposerHandle>) => (
    <ChatComposer ref={ref} chatId={chatId} onSend={onSend} />
  ),
  concierge: (chatId: string | null, onSend: OnSend, ref: Ref<ChatComposerHandle>) => (
    <ReplyDraftHarness>
      <ConciergeComposer ref={ref} chatId={chatId} onSend={onSend} />
    </ReplyDraftHarness>
  ),
};

/**
 * Opens the chat's message field, as navigating to the chat or reloading does.
 * A null `chatId` is a chat not made yet; `made` gives it its id, as the first
 * send does.
 */
function openChat(
  kind: keyof typeof composers,
  chatId: string | null,
  onSend = rs.fn(async () => {}),
) {
  const handle = createRef<ChatComposerHandle>();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const tree = (id: string | null) => (
    <MemoryRouter>
      <QueryClientProvider client={client}>
        {composers[kind](id, onSend, handle)}
      </QueryClientProvider>
    </MemoryRouter>
  );
  const view = render(tree(chatId));
  const field = () => view.container.querySelector("form textarea") as HTMLTextAreaElement;
  const type = (text: string) => fireEvent.change(field(), { target: { value: text } });
  const made = (id: string) => view.rerender(tree(id));
  return { onSend, field, type, handle, made, leave: view.unmount };
}

/** A send the test settles by hand, after the field may be gone. */
function heldSend() {
  let settle: (accepted: boolean) => void = () => {};
  const onSend = rs.fn(
    () =>
      new Promise<void>((resolve, reject) => {
        settle = (accepted) => (accepted ? resolve() : reject(new Error("refused")));
      }),
  );
  return { onSend, settle: (accepted: boolean) => act(async () => settle(accepted)) };
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

  it("is gone once a send with a file is accepted after the guardian left", async () => {
    const send = heldSend();
    const first = openChat(kind, "chat-a", send.onSend);
    act(() => first.handle.current?.addFiles([new File(["x"], "plan.txt")]));
    first.type("with a file");
    fireEvent.keyDown(first.field(), { key: "Enter" });
    await waitFor(() => expect(send.onSend).toHaveBeenCalled());
    first.leave();
    await send.settle(true);

    expect(openChat(kind, "chat-a").field().value).toBe("");
  });

  it("is gone once a new chat's first send is accepted after the guardian left", async () => {
    const send = heldSend();
    const first = openChat(kind, null, send.onSend);
    act(() => first.handle.current?.addFiles([new File(["x"], "plan.txt")]));
    first.type("with a file");
    fireEvent.keyDown(first.field(), { key: "Enter" });
    await waitFor(() => expect(send.onSend).toHaveBeenCalled());
    first.made("chat-new");
    first.leave();
    await send.settle(true);

    expect(openChat(kind, "chat-new").field().value).toBe("");
  });

  it("comes back when a send fails after the guardian left", async () => {
    const send = heldSend();
    const first = openChat(kind, "chat-a", send.onSend);
    first.type("send me");
    fireEvent.keyDown(first.field(), { key: "Enter" });
    await waitFor(() => expect(send.onSend).toHaveBeenCalled());
    first.leave();
    await send.settle(false);

    expect(openChat(kind, "chat-a").field().value).toBe("send me");
  });

  it("is gone once the chat is deleted", async () => {
    const first = openChat(kind, "chat-a");
    first.type("about to go");
    first.leave();
    rs.spyOn(globalThis, "fetch").mockImplementation(
      (async () => new Response(null, { status: 204 })) as typeof fetch,
    );
    await deleteSession("chat-a");

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

describe("the stored chat draft", () => {
  it("keeps its text when its listening reason is one this release does not know", () => {
    localStorage.setItem(
      "rome:chat-draft:chat-a",
      JSON.stringify({
        version: 1,
        text: "half a thought",
        stop: { reason: "a-reason-from-elsewhere" },
        authEpoch: currentAuthEpoch(),
      }),
    );

    expect(loadChatDraft("chat-a")).toEqual({ text: "half a thought", stop: null });
  });

  it("takes back a failed send's text beside a saved reason", () => {
    const stop = { reason: "left-chat" } as const;
    saveChatDraft("chat-a", { text: "", stop }, currentAuthEpoch());

    restoreUnsentChatDraft("chat-a", "send me", currentAuthEpoch());

    expect(loadChatDraft("chat-a")).toEqual({ text: "send me", stop });
  });

  it("is not cleared by a tab still open from before a logout", () => {
    const before = currentAuthEpoch();
    invalidateNewChatDrafts();
    clearAllChatDrafts();
    saveChatDraft("chat-a", { text: "after logging in again", stop: null }, currentAuthEpoch());

    saveChatDraft("chat-a", { text: "", stop: null }, before);

    expect(loadChatDraft("chat-a")?.text).toBe("after logging in again");
  });
});
