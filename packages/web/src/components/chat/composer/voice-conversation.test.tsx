// @rstest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeAll, describe, expect, it, rs } from "@rstest/core";
import i18n from "@/i18n";
import { ReplyDraftHarness } from "../reply/reply-draft-harness";
import type { ChatComposerHandle } from "../ChatComposer";
import { ConciergeComposer } from "./ConciergeComposer";

// The conversation itself: the test plays Rome.
const conversation = rs.hoisted(() => ({
  started: [] as string[],
  handlers: null as null | {
    onState(state: string): void;
    onEnded(reason: string | null, unsent: string): void;
    onHeard?(text: string): void;
    onCaption?(text: string): void;
    onTurn?(text: string, inputId: string): void;
  },
  muted: [] as boolean[],
  ended: 0,
  unsent: "",
}));
rs.mock("@/lib/voice-conversation/conversation", () => ({
  startVoiceConversation: (chatId: string, handlers: typeof conversation.handlers) => {
    conversation.started.push(chatId);
    conversation.handlers = handlers;
    return {
      end: () => {
        conversation.ended += 1;
        handlers?.onEnded(null, conversation.unsent);
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
  conversation.unsent = "";
  // Drafts are saved per chat, and every test talks in the same one.
  localStorage.clear();
});

function renderComposer(
  available: boolean,
  ref = createRef<ChatComposerHandle>(),
  voice: {
    onVoiceHeard?: (text: string) => void;
    onVoiceTurn?: (text: string, inputId: string) => void;
  } = {},
) {
  rs.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) => {
    const path = new URL(String(input), "http://rome.test").pathname;
    if (path === "/api/voice-conversation") return Response.json({ available });
    if (path === "/api/voice-input") return Response.json({ available: true, place: null });
    if (path === "/api/settings") return Response.json({});
    return Response.json({}, { status: 404 });
  }) as typeof fetch);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <ReplyDraftHarness>
          <ConciergeComposer ref={ref} chatId="concierge" onSend={() => {}} {...voice} />
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

    // The icon shows the microphone as it is: on, then struck through once muted.
    const icon = (name: string) =>
      screen.getByRole("button", { name }).querySelector("svg")?.getAttribute("class") ?? "";
    expect(icon("Mute")).toMatch(/\blucide-mic\b(?!-)/);
    fireEvent.click(screen.getByRole("button", { name: "Mute" }));
    expect(conversation.muted).toEqual([true]);
    expect(screen.getByRole("button", { name: "Unmute" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(icon("Unmute")).toContain("lucide-mic-off");
    expect(screen.getByRole("status").textContent).toBe("Muted");

    fireEvent.click(screen.getByRole("button", { name: "End" }));
    expect(conversation.ended).toBe(1);
    expect(document.querySelector("[data-voice-conversation-capsule]")).toBeNull();
    expect(screen.getByRole("button", { name: "Voice conversation" })).toBeTruthy();
  });

  it("hands the chat the words not sent yet and each sent turn, and shows Rome's sentence while its audio plays", async () => {
    const heard: string[] = [];
    const turns: Array<[string, string]> = [];
    renderComposer(true, undefined, {
      onVoiceHeard: (text) => heard.push(text),
      onVoiceTurn: (text, inputId) => turns.push([text, inputId]),
    });
    fireEvent.click(await screen.findByRole("button", { name: "Voice conversation" }));
    const shown = () => document.querySelector("[data-voice-conversation-text]");
    expect(shown()).toBeNull();

    // The guardian's words grow in the chat, not under the capsule.
    act(() => conversation.handlers?.onHeard?.("Book a table for"));
    expect(heard.at(-1)).toBe("Book a table for");
    expect(shown()).toBeNull();

    act(() => {
      conversation.handlers?.onHeard?.("");
      conversation.handlers?.onTurn?.("Book a table for four", "spoken-1");
    });
    expect(heard.at(-1)).toBe("");
    expect(turns).toEqual([["Book a table for four", "spoken-1"]]);

    act(() => {
      conversation.handlers?.onState("speaking");
      conversation.handlers?.onCaption?.("For how many?");
    });
    expect(shown()?.textContent).toBe("For how many?");
    // While Rome's sentence shows, what is heard may be its own voice: the chat gets none of it.
    act(() => conversation.handlers?.onHeard?.("for how"));
    expect(heard.at(-1)).toBe("");

    // Rome says listening while its audio still plays here: the sentence stays until it ends.
    act(() => conversation.handlers?.onState("listening"));
    expect(shown()?.textContent).toBe("For how many?");
    act(() => conversation.handlers?.onCaption?.(""));
    expect(shown()).toBeNull();
  });

  it("puts the words a conversation ended before sending in the field", async () => {
    renderComposer(true);
    const field = (await screen.findByRole("textbox")) as HTMLTextAreaElement;
    fireEvent.change(field, { target: { value: "Also" } });
    fireEvent.click(screen.getByRole("button", { name: "Voice conversation" }));

    conversation.unsent = "remind me at seven";
    fireEvent.click(screen.getByRole("button", { name: "End" }));
    expect(field.value).toBe("Also remind me at seven");
    // Nothing is sent: the guardian decides.
    expect(screen.getByRole("button", { name: "Send" })).toBeTruthy();
  });

  it("saves the words as the chat's draft when leaving the chat ends the conversation", async () => {
    const { unmount } = renderComposer(true);
    const field = (await screen.findByRole("textbox")) as HTMLTextAreaElement;
    fireEvent.change(field, { target: { value: "Also" } });
    fireEvent.click(screen.getByRole("button", { name: "Voice conversation" }));

    conversation.unsent = "remind me at seven";
    unmount();
    expect(conversation.ended).toBe(1);

    renderComposer(true);
    const reopened = (await screen.findByRole("textbox")) as HTMLTextAreaElement;
    expect(reopened.value).toBe("Also remind me at seven");
  });

  it("ends the conversation when the host hides the composer without unmounting it", async () => {
    const ref = createRef<ChatComposerHandle>();
    renderComposer(true, ref);
    fireEvent.click(await screen.findByRole("button", { name: "Voice conversation" }));
    expect(document.querySelector("[data-voice-conversation-capsule]")).toBeTruthy();

    // What the chat calls when sharing or a pane covers the composer.
    act(() => ref.current?.stopVoiceInput());
    expect(conversation.ended).toBe(1);
    expect(document.querySelector("[data-voice-conversation-capsule]")).toBeNull();
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
