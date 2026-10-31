// @rstest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, rs } from "@rstest/core";
import i18n from "@/i18n";
import type { ChatComposerSnapshot } from "../ChatComposer";
import { ConciergeComposer, type ConciergeComposerProps } from "./ConciergeComposer";
import { ReplyDraftHarness } from "../reply/reply-draft-harness";
import type { ReplyTarget } from "../reply/reply-draft";

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

afterEach(() => {
  rs.useRealTimers();
  cleanup();
  rs.restoreAllMocks();
});

function renderComposer(props: Partial<ConciergeComposerProps> = {}, reply?: ReplyTarget) {
  rs.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) =>
    String(input) === "/api/settings"
      ? Response.json({ enableModelSelector: true, webchatReasoningEffort: "low" })
      : Response.json({}, { status: 404 })) as typeof fetch);
  const onSend = rs.fn(async (_snapshot: ChatComposerSnapshot) => {});
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const ui = (next: Partial<ConciergeComposerProps>) => (
    <QueryClientProvider client={client}>
      <ReplyDraftHarness initial={reply}>
        <ConciergeComposer onSend={onSend} {...next} />
      </ReplyDraftHarness>
    </QueryClientProvider>
  );
  const view = render(ui(props));
  return { onSend, rerender: (next: Partial<ConciergeComposerProps>) => view.rerender(ui(next)) };
}

describe("ConciergeComposer", () => {
  it("is one text line between + and Send, and sends on Enter", async () => {
    const { onSend } = renderComposer();
    const box = screen.getByPlaceholderText("Message");
    expect(box.getAttribute("rows")).toBe("1");
    // Only the + and Send sit around the text: no toolbar row.
    expect(screen.getAllByRole("button").map((b) => b.getAttribute("aria-label"))).toEqual([
      "Add files or change the model",
      expect.any(String),
    ]);
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());
    await userEvent.type(box, "hi{Enter}");
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect(onSend.mock.calls[0][0]).toMatchObject({ text: "hi", uploads: [] });
    expect((box as HTMLTextAreaElement).value).toBe("");
  });

  it("opens a menu with file upload and a model submenu from +", async () => {
    const onChange = rs.fn();
    renderComposer({ modelSelection: { value: "claude-sonnet", onChange } });
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());
    screen.getByRole("button", { name: "Add files or change the model" }).focus();
    await userEvent.keyboard("{Enter}");
    expect(await screen.findByRole("menuitem", { name: /Upload files/ })).toBeTruthy();
    const model = await screen.findByRole("menuitem", { name: /Model/ });
    // The submenu trigger names the chat's current model.
    expect(model.textContent).toContain("Sonnet");
    model.focus();
    await userEvent.keyboard("{ArrowRight}");
    // Short list first: the common models plus the chat's own pick.
    const names = async () =>
      (await screen.findAllByRole("menuitemradio")).map((item) => item.textContent);
    expect(await names()).toEqual(["Auto", "Opus 5.5", "Sonnet", "GPT-6 Astra"]);
    expect(screen.queryByRole("menuitemradio", { name: "GPT-6 Luna" })).toBeNull();
    // "Show all" expands the list in place and keeps the menu open.
    await userEvent.click(screen.getByRole("menuitem", { name: /Show all \d+ models/ }));
    expect((await names()).length).toBeGreaterThan(4);
    await userEvent.click(screen.getByRole("menuitemradio", { name: "GPT-6 Luna" }));
    expect(onChange).toHaveBeenCalledWith("gpt-6-luna");
  });

  it("leaves the model out when the chat cannot change its model", async () => {
    renderComposer();
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());
    screen.getByRole("button", { name: "Add files or change the model" }).focus();
    await userEvent.keyboard("{Enter}");
    expect(await screen.findByRole("menuitem", { name: /Upload files/ })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: /Model/ })).toBeNull();
  });
});

describe("ConciergeComposer Stop", () => {
  const stop = () => screen.queryByRole("button", { name: "Stop generating" });

  it("turns Send into Stop while a visible turn runs and nothing is typed", async () => {
    const onStop = rs.fn(async () => true);
    const { onSend } = renderComposer({ isStreaming: true, canStop: true, onStop });
    expect(screen.queryByRole("button", { name: "Send while agent is working" })).toBeNull();

    await userEvent.click(stop()!);

    expect(onStop).toHaveBeenCalledTimes(1);
    expect(onSend).not.toHaveBeenCalled();
  });

  it("is Send again once the guardian types, and Enter never stops", async () => {
    const onStop = rs.fn(async () => true);
    const { onSend } = renderComposer({ isStreaming: true, canStop: true, onStop });
    const box = screen.getByPlaceholderText("Message");

    await userEvent.type(box, "{Enter}");
    expect(onStop).not.toHaveBeenCalled();

    await userEvent.type(box, "wait, no");
    expect(stop()).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Send while agent is working" }));

    expect(onStop).not.toHaveBeenCalled();
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect(onSend.mock.calls[0][0]).toMatchObject({ text: "wait, no" });
  });

  it("stays a disabled Send when no visible turn runs, or when Stop is not offered", () => {
    renderComposer({ isStreaming: true, canStop: false, onStop: rs.fn(async () => true) });
    expect(stop()).toBeNull();
    cleanup();
    renderComposer({ isStreaming: true, canStop: true });
    expect(stop()).toBeNull();
    expect(
      (screen.getByRole("button", { name: "Send while agent is working" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });
});

describe("ConciergeComposer Stop while the server answers", () => {
  const stopButton = () => screen.queryByRole("button", { name: "Stop generating" });
  const spinner = () =>
    screen.queryByRole("button", { name: "Stopping…" }) as HTMLButtonElement | null;
  const sendButton = () => screen.queryByRole("button", { name: "Send while agent is working" });

  /** A Stop the test answers by hand. */
  function pendingStop() {
    let answer!: (confirmed: boolean) => void;
    const onStop = rs.fn(
      () =>
        new Promise<boolean>((resolve) => {
          answer = resolve;
        }),
    );
    return {
      onStop,
      answer: async (confirmed: boolean) => {
        await act(async () => {
          answer(confirmed);
          await rs.advanceTimersByTimeAsync(0);
        });
      },
    };
  }
  const advance = (ms: number) => act(async () => void (await rs.advanceTimersByTimeAsync(ms)));

  it("turns Stop into a disabled spinner as soon as it is pressed", () => {
    rs.useFakeTimers();
    const { onStop } = pendingStop();
    renderComposer({ isStreaming: true, canStop: true, onStop });

    fireEvent.click(stopButton()!);

    expect(spinner()!.disabled).toBe(true);
    expect(stopButton()).toBeNull();
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it("shows Send 300 ms after the server confirmed, and not before", async () => {
    rs.useFakeTimers();
    const { onStop, answer } = pendingStop();
    renderComposer({ isStreaming: true, canStop: true, onStop });
    fireEvent.click(stopButton()!);

    await answer(true);
    await advance(299);
    expect(spinner()).not.toBeNull();
    await advance(1);

    expect(spinner()).toBeNull();
    expect(stopButton()).toBeNull();
    expect(sendButton()).not.toBeNull();
  });

  it("goes back to Stop when the server refused", async () => {
    rs.useFakeTimers();
    const { onStop, answer } = pendingStop();
    renderComposer({ isStreaming: true, canStop: true, onStop });
    fireEvent.click(stopButton()!);

    await answer(false);

    expect(spinner()).toBeNull();
    expect((stopButton() as HTMLButtonElement).disabled).toBe(false);
  });

  it("stops waiting after 10 s without an answer", async () => {
    rs.useFakeTimers();
    const { onStop } = pendingStop();
    renderComposer({ isStreaming: true, canStop: true, onStop });
    fireEvent.click(stopButton()!);

    await advance(9_999);
    expect(spinner()).not.toBeNull();
    await advance(1);

    expect(spinner()).toBeNull();
    expect(sendButton()).not.toBeNull();
  });

  it("offers Stop again after a message is sent, since it starts a new turn", async () => {
    rs.useFakeTimers();
    const { onStop, answer } = pendingStop();
    const { onSend } = renderComposer({ isStreaming: true, canStop: true, onStop });
    fireEvent.click(stopButton()!);
    await answer(true);
    await advance(300);
    expect(stopButton()).toBeNull();

    const box = screen.getByPlaceholderText("Message");
    fireEvent.change(box, { target: { value: "never mind" } });
    await act(async () => {
      fireEvent.keyDown(box, { key: "Enter" });
      await rs.advanceTimersByTimeAsync(0);
    });

    expect(onSend).toHaveBeenCalledTimes(1);
    expect(stopButton()).not.toBeNull();
  });

  it("offers Stop again for the next turn, once canStop has dropped", async () => {
    rs.useFakeTimers();
    const { onStop, answer } = pendingStop();
    const { rerender } = renderComposer({ isStreaming: true, canStop: true, onStop });
    fireEvent.click(stopButton()!);
    await answer(true);
    await advance(300);
    expect(stopButton()).toBeNull();

    rerender({ isStreaming: false, canStop: false, onStop });
    rerender({ isStreaming: true, canStop: true, onStop });

    expect(stopButton()).not.toBeNull();
  });
});

describe("ConciergeComposer reply", () => {
  const reply: ReplyTarget = {
    messageId: "a1",
    author: "agent",
    quote: "Lisbon",
    preview: "Lisbon",
  };

  it("holds the reply as a chip, sends it with the message, and clears it", async () => {
    const { onSend } = renderComposer({}, reply);
    expect(await screen.findByRole("button", { name: "Cancel reply" })).toBeTruthy();

    await userEvent.type(screen.getByPlaceholderText("Message"), "why there?{Enter}");

    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect(onSend.mock.calls[0][0]).toMatchObject({ text: "why there?", replyTo: reply });
    expect(screen.queryByRole("button", { name: "Cancel reply" })).toBeNull();
  });

  it("puts the reply back when the send fails", async () => {
    const { onSend } = renderComposer({}, reply);
    onSend.mockRejectedValueOnce(new Error("offline"));

    await userEvent.type(await screen.findByPlaceholderText("Message"), "why there?{Enter}");

    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole("button", { name: "Cancel reply" })).toBeTruthy();
    expect((screen.getByPlaceholderText("Message") as HTMLTextAreaElement).value).toBe(
      "why there?",
    );
  });

  it("drops the reply on Escape, and from the chip's ×", async () => {
    renderComposer({}, reply);
    await screen.findByRole("button", { name: "Cancel reply" });

    await userEvent.type(screen.getByPlaceholderText("Message"), "{Escape}");
    expect(screen.queryByRole("button", { name: "Cancel reply" })).toBeNull();
  });

  it("drops the reply from the chip's ×", async () => {
    renderComposer({}, reply);

    await userEvent.click(await screen.findByRole("button", { name: "Cancel reply" }));

    expect(screen.queryByRole("button", { name: "Cancel reply" })).toBeNull();
  });
});
