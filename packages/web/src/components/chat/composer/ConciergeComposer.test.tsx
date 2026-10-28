// @rstest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
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
  render(
    <QueryClientProvider client={client}>
      <ReplyDraftHarness initial={reply}>
        <ConciergeComposer onSend={onSend} {...props} />
      </ReplyDraftHarness>
    </QueryClientProvider>,
  );
  return { onSend };
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
