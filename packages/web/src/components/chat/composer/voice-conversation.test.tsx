// @rstest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeAll, describe, expect, it, rs } from "@rstest/core";
import i18n from "@/i18n";
import { ReplyDraftHarness } from "../reply/reply-draft-harness";
import { ConciergeComposer } from "./ConciergeComposer";

// The conversation itself: the test plays Rome.
const conversation = rs.hoisted(() => ({
  started: [] as string[],
  handlers: null as null | {
    onState(state: string): void;
    onEnded(reason: string | null): void;
  },
  muted: [] as boolean[],
  ended: 0,
}));
rs.mock("@/lib/voice-conversation/conversation", () => ({
  startVoiceConversation: (chatId: string, handlers: typeof conversation.handlers) => {
    conversation.started.push(chatId);
    conversation.handlers = handlers;
    return {
      end: () => {
        conversation.ended += 1;
        handlers?.onEnded(null);
      },
      setMuted: (muted: boolean) => conversation.muted.push(muted),
      micLevel: () => 0,
      replyLevel: () => 0,
    };
  },
}));

beforeAll(async () => {
  await i18n.changeLanguage("en");
});
afterEach(() => {
  cleanup();
  rs.restoreAllMocks();
  conversation.started = [];
  conversation.handlers = null;
  conversation.muted = [];
  conversation.ended = 0;
});

function renderComposer(available: boolean) {
  rs.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) => {
    const path = new URL(String(input), "http://rome.test").pathname;
    if (path === "/api/voice-conversation") return Response.json({ available });
    if (path === "/api/voice-input") return Response.json({ available: true, place: null });
    if (path === "/api/settings") return Response.json({});
    return Response.json({}, { status: 404 });
  }) as typeof fetch);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <ReplyDraftHarness>
          <ConciergeComposer chatId="concierge" onSend={() => {}} />
        </ReplyDraftHarness>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe("voice conversation in the Concierge's message field", () => {
  it("offers the button beside voice input only while voice mode is on", async () => {
    renderComposer(true);
    expect(await screen.findByRole("button", { name: "Voice conversation" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Start voice input" })).toBeTruthy();
  });

  it("offers no button while voice mode is off", async () => {
    renderComposer(false);
    await screen.findByRole("button", { name: "Start voice input" });
    expect(screen.queryByRole("button", { name: "Voice conversation" })).toBeNull();
  });

  it("shows the capsule above the field, and mute and end in place of send", async () => {
    renderComposer(true);
    fireEvent.click(await screen.findByRole("button", { name: "Voice conversation" }));
    expect(conversation.started).toEqual(["concierge"]);
    expect(document.querySelector("[data-voice-conversation-capsule]")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("Listening");
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Start voice input" })).toBeNull();

    act(() => conversation.handlers?.onState("speaking"));
    expect(screen.getByRole("status").textContent).toBe("Speaking");

    fireEvent.click(screen.getByRole("button", { name: "Mute" }));
    expect(conversation.muted).toEqual([true]);
    expect(screen.getByRole("button", { name: "Unmute" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(screen.getByRole("status").textContent).toBe("Muted");

    fireEvent.click(screen.getByRole("button", { name: "End" }));
    expect(conversation.ended).toBe(1);
    expect(document.querySelector("[data-voice-conversation-capsule]")).toBeNull();
    expect(screen.getByRole("button", { name: "Voice conversation" })).toBeTruthy();
  });

  it("says why a conversation ended on its own", async () => {
    renderComposer(true);
    fireEvent.click(await screen.findByRole("button", { name: "Voice conversation" }));
    act(() => conversation.handlers?.onEnded("chat-refused"));
    expect(screen.getByRole("status").textContent).toBe(
      "This chat can't take a voice conversation",
    );
  });
});
