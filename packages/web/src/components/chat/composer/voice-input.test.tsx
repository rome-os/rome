// @rstest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, rs } from "@rstest/core";
import type { VoiceInputInfo } from "@rome/api-types/voice-input";
import i18n from "@/i18n";
import { ChatComposer } from "../ChatComposer";
import { ConciergeComposer } from "./ConciergeComposer";
import { ReplyDraftHarness } from "../reply/reply-draft-harness";

// The browser's microphone, which jsdom does not have.
const microphone = rs.hoisted(() => ({
  refuse: false,
  /** While true, the permission prompt never answers. */
  pending: false,
  /** The audio still in the capture buffer when listening stops. */
  tail: null as ArrayBuffer | null,
  closed: 0,
  onAudio: null as ((chunk: ArrayBuffer) => void) | null,
}));
rs.mock("@/lib/voice-input/microphone", () => ({
  openMicrophone: async (onAudio: (chunk: ArrayBuffer) => void) => {
    if (microphone.pending) await new Promise(() => {});
    if (microphone.refuse) throw new DOMException("denied", "NotAllowedError");
    microphone.onAudio = onAudio;
    return {
      sampleRate: 16000,
      finish: async () => {
        if (microphone.tail) onAudio(microphone.tail);
        microphone.closed += 1;
      },
      close: () => {
        microphone.closed += 1;
      },
    };
  },
}));

/** Stands in for Rome's dictation socket. */
class FakeSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static last: FakeSocket | null = null;
  /** False keeps every socket connecting, as a stalled handshake does. */
  static opens = true;
  readyState = FakeSocket.CONNECTING;
  binaryType = "blob";
  sent: Array<string | ArrayBuffer> = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.last = this;
    queueMicrotask(() => {
      if (!FakeSocket.opens) return;
      this.readyState = FakeSocket.OPEN;
      this.onopen?.();
    });
  }
  send(data: string | ArrayBuffer) {
    this.sent.push(data);
  }
  close() {
    this.readyState = FakeSocket.CLOSED;
  }
  /** Rome sends a message. */
  say(message: object) {
    act(() => this.onmessage?.({ data: JSON.stringify(message) }));
  }
  get textSent() {
    return this.sent
      .filter((frame): frame is string => typeof frame === "string")
      .map((f) => JSON.parse(f));
  }
}

/**
 * jsdom has no `execCommand`. This one inserts into the focused field as
 * Chrome's does: it replaces the selection and fires an input event.
 */
function insertTextAtSelection(command: string, _ui: boolean, text: string): boolean {
  const el = document.activeElement;
  if (command !== "insertText" || !(el instanceof HTMLTextAreaElement)) return false;
  const next = el.value.slice(0, el.selectionStart) + text + el.value.slice(el.selectionEnd);
  const caret = el.selectionStart + text.length;
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(el, next);
  el.setSelectionRange(caret, caret);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  return true;
}

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

beforeEach(() => {
  microphone.refuse = false;
  microphone.pending = false;
  microphone.tail = null;
  FakeSocket.opens = true;
  microphone.closed = 0;
  FakeSocket.last = null;
  rs.stubGlobal("WebSocket", FakeSocket);
  document.execCommand = insertTextAtSelection as typeof document.execCommand;
});

afterEach(() => {
  // React Query pauses every later fetch after an `offline` event until it
  // hears `online`.
  window.dispatchEvent(new Event("online"));
  rs.useRealTimers();
  cleanup();
  rs.restoreAllMocks();
  rs.unstubAllGlobals();
});

function mockFetch(info: VoiceInputInfo) {
  rs.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) => {
    const path = new URL(String(input), "http://rome.test").pathname;
    if (path === "/api/voice-input") return Response.json(info);
    if (path === "/api/settings") return Response.json({});
    if (path === "/api/people") return Response.json({ people: [], counts: {} });
    return Response.json({}, { status: 404 });
  }) as typeof fetch);
}

const SONIOX: VoiceInputInfo = {
  available: true,
  place: { provider: "Soniox", host: "stt-rt.soniox.com" },
};

const composers = {
  chat: (onSend: () => void) => <ChatComposer onSend={onSend} />,
  concierge: (onSend: () => void) => (
    <ReplyDraftHarness>
      <ConciergeComposer onSend={onSend} />
    </ReplyDraftHarness>
  ),
};

function renderComposer(kind: keyof typeof composers, info: VoiceInputInfo = SONIOX) {
  mockFetch(info);
  const onSend = rs.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <MemoryRouter>
      <QueryClientProvider client={client}>{composers[kind](onSend)}</QueryClientProvider>
    </MemoryRouter>,
  );
  const field = () => document.querySelector("form textarea") as HTMLTextAreaElement;
  return { onSend, field };
}

async function startListening() {
  fireEvent.click(await screen.findByRole("button", { name: "Start voice input" }));
  await waitFor(() =>
    expect(FakeSocket.last?.textSent).toEqual([{ type: "start", sampleRate: 16000 }]),
  );
  return FakeSocket.last!;
}

describe.each(["chat", "concierge"] as const)("voice input in the %s message field", (kind) => {
  it("has no voice control while Rome Cloud provides no voice input", async () => {
    renderComposer(kind, { available: false, place: null });
    await waitFor(() =>
      expect(globalThis.fetch).toHaveBeenCalledWith("/api/voice-input", expect.anything()),
    );
    expect(screen.queryByRole("button", { name: "Start voice input" })).toBeNull();
  });

  it("streams spoken text in at the cursor and leaves sending to the guardian", async () => {
    const { onSend, field } = renderComposer(kind);
    const box = await waitFor(() => {
      expect(field()).toBeTruthy();
      return field();
    });
    fireEvent.change(box, { target: { value: "Note:" } });
    box.setSelectionRange(5, 5);

    const socket = await startListening();
    const stop = screen.getByRole("button", { name: "Stop voice input" });
    expect(stop.getAttribute("aria-pressed")).toBe("true");
    expect(stop.closest("form")).toBe(box.closest("form"));

    socket.say({ type: "text", settled: "buy", pending: " mil" });
    expect(field().value).toBe("Note: buy mil");
    expect(field().readOnly).toBe(true);
    socket.say({ type: "text", settled: " milk", pending: "" });

    fireEvent.click(stop);
    expect(
      screen.getByRole("button", { name: "Finishing voice input" }).getAttribute("aria-pressed"),
    ).toBe("false");
    await waitFor(() => expect(socket.textSent.at(-1)).toEqual({ type: "stop" }));
    expect(microphone.closed).toBe(1);
    socket.say({ type: "ended" });
    expect(
      screen.getByRole("button", { name: "Start voice input" }).getAttribute("aria-pressed"),
    ).toBe("false");

    expect(field().value).toBe("Note: buy milk");
    expect(field().readOnly).toBe(false);
    expect(screen.queryByRole("status")).toBeNull();
    expect(onSend).not.toHaveBeenCalled();
  });

  it("replaces selected text the way typing does", async () => {
    const { field } = renderComposer(kind);
    const box = await waitFor(() => {
      expect(field()).toBeTruthy();
      return field();
    });
    fireEvent.change(box, { target: { value: "Hello old world" } });
    box.setSelectionRange(6, 9);

    const socket = await startListening();
    socket.say({ type: "text", settled: "new", pending: "" });
    expect(field().value).toBe("Hello new world");
    fireEvent.click(screen.getByRole("button", { name: "Stop voice input" }));
    socket.say({ type: "ended" });

    expect(field().value).toBe("Hello new world");
  });

  it("leaves the field and its selection as they were when nothing was heard", async () => {
    microphone.refuse = true;
    const { field } = renderComposer(kind);
    const box = await waitFor(() => {
      expect(field()).toBeTruthy();
      return field();
    });
    fireEvent.change(box, { target: { value: "Hello old world" } });
    box.setSelectionRange(6, 9);
    fireEvent.click(await screen.findByRole("button", { name: "Start voice input" }));

    await waitFor(() => expect(screen.getByRole("status")).toBeTruthy());
    expect(field().value).toBe("Hello old world");
    expect([field().selectionStart, field().selectionEnd]).toEqual([6, 9]);
  });

  it("stops at once while the microphone prompt is still open", async () => {
    microphone.pending = true;
    const { field } = renderComposer(kind);
    fireEvent.click(await screen.findByRole("button", { name: "Start voice input" }));
    fireEvent.click(screen.getByRole("button", { name: "Stop voice input" }));

    await waitFor(() => expect(field().readOnly).toBe(false));
    expect(screen.getByRole("button", { name: "Start voice input" })).toHaveProperty(
      "disabled",
      false,
    );
    expect(FakeSocket.last).toBeNull();
  });

  it("sends the last captured audio before asking for the rest of the text", async () => {
    renderComposer(kind);
    const socket = await startListening();
    microphone.tail = new Uint8Array([7, 7]).buffer;
    fireEvent.click(screen.getByRole("button", { name: "Stop voice input" }));

    await waitFor(() => expect(socket.textSent.at(-1)).toEqual({ type: "stop" }));
    expect(socket.sent.at(-2)).toBe(microphone.tail);
  });

  it("says it is finishing, not ready to start, until the rest of the text arrives", async () => {
    const { field } = renderComposer(kind);
    const socket = await startListening();
    socket.say({ type: "text", settled: "hello", pending: "" });
    fireEvent.click(screen.getByRole("button", { name: "Stop voice input" }));
    await waitFor(() => expect(socket.textSent.at(-1)).toEqual({ type: "stop" }));

    expect(screen.queryByRole("button", { name: "Start voice input" })).toBeNull();
    expect(screen.getByRole("button", { name: "Finishing voice input" })).toHaveProperty(
      "disabled",
      true,
    );
    expect(field().readOnly).toBe(true);

    socket.say({ type: "ended" });
    expect(screen.getByRole("button", { name: "Start voice input" })).toHaveProperty(
      "disabled",
      false,
    );
    expect(field().value).toBe("hello");
  });

  it("gives the field back when Rome never answers a stop", async () => {
    FakeSocket.opens = false;
    const { field } = renderComposer(kind);
    fireEvent.click(await screen.findByRole("button", { name: "Start voice input" }));
    await waitFor(() => expect(FakeSocket.last).not.toBeNull());
    rs.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    fireEvent.click(screen.getByRole("button", { name: "Stop voice input" }));
    expect(field().readOnly).toBe(true);

    // Rome's own bound on a stop runs out first, so its reason would arrive.
    act(() => rs.advanceTimersByTime(17_000));
    expect(field().readOnly).toBe(true);
    act(() => rs.advanceTimersByTime(3_000));
    rs.useRealTimers();

    expect(field().readOnly).toBe(false);
    expect(screen.getByRole("status").textContent).toBe(
      "Connection to Rome lost. Listening stopped",
    );
    expect(screen.getByRole("button", { name: "Start voice input" })).toHaveProperty(
      "disabled",
      false,
    );
  });

  it("keeps the words heard and closes the microphone the moment the browser goes offline", async () => {
    const { field } = renderComposer(kind);
    const socket = await startListening();
    socket.say({ type: "text", settled: "hello", pending: " the" });

    act(() => {
      window.dispatchEvent(new Event("offline"));
    });

    expect(field().value).toBe("hello the");
    expect(microphone.closed).toBe(1);
    expect(screen.getByRole("status").textContent).toBe(
      "Connection to Rome lost. Listening stopped",
    );
  });

  it("notices a connection that dies quietly within 5 seconds", async () => {
    const { field } = renderComposer(kind);
    const socket = await startListening();
    rs.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    socket.say({ type: "text", settled: "hello", pending: "" });
    act(() => rs.advanceTimersByTime(2_000));
    socket.say({ type: "alive" });
    act(() => rs.advanceTimersByTime(2_900));
    expect(screen.queryByRole("status")).toBeNull();

    act(() => rs.advanceTimersByTime(200));
    rs.useRealTimers();

    expect(field().value).toBe("hello");
    expect(screen.getByRole("status").textContent).toBe(
      "Connection to Rome lost. Listening stopped",
    );
  });

  it("keeps the words heard and says the connection was lost when it drops after a stop", async () => {
    const { field } = renderComposer(kind);
    const socket = await startListening();
    socket.say({ type: "text", settled: "hello", pending: " the" });
    fireEvent.click(screen.getByRole("button", { name: "Stop voice input" }));
    await waitFor(() => expect(socket.textSent.at(-1)).toEqual({ type: "stop" }));
    act(() => socket.onclose?.());

    expect(field().value).toBe("hello the");
    expect(screen.getByRole("status").textContent).toBe(
      "Connection to Rome lost. Listening stopped",
    );
  });

  it("keeps the words heard and says why when the transcriber stops listening", async () => {
    const { field } = renderComposer(kind);
    const socket = await startListening();
    socket.say({ type: "text", settled: "hello", pending: " the" });
    socket.say({ type: "error", reason: "provider-unavailable" });

    expect(field().value).toBe("hello the");
    expect(screen.getByRole("status").textContent).toBe(
      "Transcription service unavailable. Listening stopped",
    );
    expect(screen.getByRole("button", { name: "Start voice input" })).toBeTruthy();
  });

  it("says why when Rome Cloud refuses voice input", async () => {
    const { field } = renderComposer(kind);
    const socket = await startListening();
    socket.say({ type: "error", reason: "service-refused", detail: "voice_input_rate_limited" });

    expect(field().value).toBe("");
    expect(screen.getByRole("status").textContent).toBe(
      "Too many voice inputs in the last minute. Try again shortly",
    );
  });

  it("names a Rome Cloud reason the dashboard has no words for", async () => {
    renderComposer(kind);
    const socket = await startListening();
    socket.say({ type: "error", reason: "service-refused", detail: "account_suspended" });

    expect(screen.getByRole("status").textContent).toBe(
      "Rome Cloud refused voice input (account_suspended). Listening stopped",
    );
  });

  it("says how to allow a refused microphone", async () => {
    microphone.refuse = true;
    renderComposer(kind);
    fireEvent.click(await screen.findByRole("button", { name: "Start voice input" }));

    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toBe(
        "Microphone blocked. Allow it in the browser's site settings",
      ),
    );
    expect(FakeSocket.last).toBeNull();
  });
});

describe("voice input when a card locks the chat message field", () => {
  it("stops listening, so the microphone does not stay open behind the lock", async () => {
    mockFetch(SONIOX);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const tree = (lockedReason: string | null) => (
      <MemoryRouter>
        <QueryClientProvider client={client}>
          <ChatComposer onSend={rs.fn()} lockedReason={lockedReason} />
        </QueryClientProvider>
      </MemoryRouter>
    );
    const { rerender } = render(tree(null));
    const socket = await startListening();
    socket.say({ type: "text", settled: "half a", pending: "" });

    rerender(tree("Answer the card above to continue."));

    await waitFor(() => expect(socket.textSent.at(-1)).toEqual({ type: "stop" }));
    expect(microphone.closed).toBe(1);
  });

  it("inserts text heard behind the lock as one undoable edit once the field shows again", async () => {
    // jsdom renders nothing, so the hidden field is staged: it has no boxes and
    // cannot take focus until it shows.
    let hidden = false;
    const observers: Array<() => void> = [];
    rs.stubGlobal(
      "ResizeObserver",
      class {
        constructor(readonly callback: () => void) {
          observers.push(() => this.callback());
        }
        observe() {}
        disconnect() {}
      },
    );
    const realFocus = HTMLTextAreaElement.prototype.focus;
    rs.spyOn(HTMLTextAreaElement.prototype, "focus").mockImplementation(function (
      this: HTMLTextAreaElement,
    ) {
      if (!hidden) realFocus.call(this);
    });
    rs.spyOn(HTMLTextAreaElement.prototype, "getClientRects").mockImplementation(
      () => ({ length: hidden ? 0 : 1 }) as DOMRectList,
    );
    const execCommand = rs.spyOn(document, "execCommand");
    mockFetch(SONIOX);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const tree = (lockedReason: string | null) => (
      <MemoryRouter>
        <QueryClientProvider client={client}>
          <ChatComposer onSend={rs.fn()} lockedReason={lockedReason} />
        </QueryClientProvider>
      </MemoryRouter>
    );
    const { rerender } = render(tree(null));
    const field = () => document.querySelector("form textarea") as HTMLTextAreaElement;
    const socket = await startListening();
    socket.say({ type: "text", settled: "hello", pending: "" });

    hidden = true;
    (document.activeElement as HTMLElement | null)?.blur();
    rerender(tree("Answer the card above to continue."));
    await waitFor(() => expect(socket.textSent.at(-1)).toEqual({ type: "stop" }));
    socket.say({ type: "ended" });

    // The draft keeps the words while the field is hidden.
    expect(field().value).toBe("hello");
    expect(execCommand).not.toHaveBeenCalled();

    hidden = false;
    rerender(tree(null));
    act(() => {
      for (const observe of observers) observe();
    });

    expect(execCommand).toHaveBeenCalledWith("insertText", false, "hello");
    expect(field().value).toBe("hello");
  });
});
