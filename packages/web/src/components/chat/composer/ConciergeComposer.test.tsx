// @rstest-environment jsdom
import { createRef } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, rs } from "@rstest/core";
import i18n from "@/i18n";
import type { ChatComposerHandle, ChatComposerSnapshot } from "../ChatComposer";
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

function renderComposer(
  props: Partial<ConciergeComposerProps> = {},
  reply?: ReplyTarget,
  selector = true,
  ref?: React.Ref<ChatComposerHandle>,
  threads = false,
) {
  rs.spyOn(globalThis, "fetch").mockImplementation(
    (async (input: RequestInfo | URL) =>
      ({
        "/api/skills": () =>
          Response.json({
            skills: [
              {
                name: "@ray/scoped-app:identity_probe",
                localName: "identity_probe",
                description: "Scoped identity probe",
                tools: [],
                ownerType: "app",
                ownerId: "@ray/scoped-app",
                ownerLabel: "Scoped App",
                ownerDescription: "Scoped app test fixture",
                iconUrl: null,
              },
            ],
          }),
        "/api/settings": () =>
          Response.json({
            enableModelSelector: selector,
            webchatReasoningEffort: "low",
          }),
        "/api/chat/locations": () =>
          Response.json({
            projects: {
              rootPath: "/home/alex/.rome/default/projects",
              defaultPath: "/home/alex/.rome/default/projects",
              projects: [{ name: "app", path: "/home/alex/.rome/default/projects/app" }],
            },
            devices: [{ id: "0f3c", name: "workstation", platform: "macos" }],
          }),
        "/api/devices/0f3c/files": () =>
          Response.json({
            path: "/home/alex",
            parent: "/home",
            entries: [],
            truncated: false,
          }),
      })[new URL(String(input), "http://rome.test").pathname]?.() ??
      Response.json({}, { status: 404 })) as typeof fetch,
  );
  const onSend = rs.fn(async (_snapshot: ChatComposerSnapshot) => {});
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const tree = (next: Partial<ConciergeComposerProps>) => (
    <QueryClientProvider client={client}>
      <ReplyDraftHarness initial={reply} thread={threads ? "a1" : undefined}>
        <ConciergeComposer ref={ref} onSend={onSend} {...next} />
      </ReplyDraftHarness>
    </QueryClientProvider>
  );
  const view = render(tree(props));
  return {
    onSend,
    rerenderWith: (next: Partial<ConciergeComposerProps>) => view.rerender(tree(next)),
  };
}

describe("ConciergeComposer", () => {
  it("says a topic chat's name in its placeholder, and follows a rename", () => {
    const { rerenderWith } = renderComposer({ chatName: "Trip to Lisbon" });
    expect(screen.getByPlaceholderText("Message in Trip to Lisbon")).toBeTruthy();
    rerenderWith({ chatName: "Lisbon flights" });
    expect(screen.getByPlaceholderText("Message in Lisbon flights")).toBeTruthy();
  });

  it("keeps the plain placeholder without a chat name", () => {
    renderComposer({ chatName: null });
    expect(screen.getByPlaceholderText("Message")).toBeTruthy();
  });

  it("picks a scoped skill, sends a chip-only turn, and clears the chip", async () => {
    const { onSend } = renderComposer();
    const box = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.input(box, { target: { value: "/@ray/scoped-app:identity_probe" } });
    expect(await screen.findByText("Scoped App")).toBeTruthy();
    fireEvent.mouseDown(screen.getByText("/identity_probe"));
    expect(screen.getByRole("button", { name: "Remove skill" })).toBeTruthy();
    expect(box.value).toBe("");
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect(onSend.mock.calls[0][0]).toMatchObject({
      text: "",
      skillName: "@ray/scoped-app:identity_probe",
    });
    expect(screen.queryByRole("button", { name: "Remove skill" })).toBeNull();
  });

  it("navigates the slash menu with arrows, accepts with Enter, and removes the chip with its button", async () => {
    const { onSend } = renderComposer();
    const box = screen.getByRole("textbox") as HTMLTextAreaElement;
    await userEvent.type(box, "/");
    await screen.findByText("/identity_probe");
    await userEvent.keyboard("{ArrowDown}{ArrowUp}{ArrowRight}{ArrowLeft}{ArrowRight}{Enter}");
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Remove skill" })).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Remove skill" }));
    expect(screen.queryByRole("button", { name: "Remove skill" })).toBeNull();
  });

  it("dismisses the slash menu with Escape and ignores file paths", async () => {
    renderComposer();
    const box = screen.getByRole("textbox") as HTMLTextAreaElement;
    await userEvent.type(box, "/");
    await screen.findByText("/identity_probe");
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByText("/identity_probe")).toBeNull();
    fireEvent.input(box, { target: { value: "/etc/hosts" } });
    expect(screen.queryByText("/identity_probe")).toBeNull();
  });

  it("preserves task text after the cursor when accepting a slash skill", async () => {
    const { onSend } = renderComposer();
    const box = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.input(box, { target: { value: "/identity_probe inspect this" } });
    box.setSelectionRange(15, 15);
    fireEvent.select(box);
    await screen.findByText("/identity_probe");
    fireEvent.mouseDown(screen.getByText("/identity_probe"));
    expect(box.value).toBe("inspect this");
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(onSend.mock.calls[0][0]).toMatchObject({
      text: "inspect this",
      skillName: "@ray/scoped-app:identity_probe",
    });
  });

  it("supports programmatic selection and restores a selected skill after a failed send", async () => {
    const ref = createRef<ChatComposerHandle>();
    const onSend = rs.fn().mockRejectedValueOnce(new Error("failed")).mockResolvedValue(undefined);
    renderComposer({ onSend }, undefined, true, ref);
    act(() => ref.current?.setSkillSelection({ name: "@ray/scoped-app:identity_probe" }));
    await screen.findByRole("button", { name: "Remove skill" });
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    await screen.findByRole("button", { name: "Remove skill" });
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(onSend).toHaveBeenCalledTimes(2);
    expect(onSend.mock.calls[0][0]).toEqual(onSend.mock.calls[1][0]);
  });

  it.each([
    [false, true],
    [true, false],
  ])("hides Stop when streaming=%s and a handler is present=%s", (isStreaming, hasHandler) => {
    renderComposer({ isStreaming, onStop: hasHandler ? rs.fn() : undefined });
    expect(screen.queryByRole("button", { name: "Stop generating" })).toBeNull();
  });

  it("stops without sending, and keeps the draft and Send available while running", async () => {
    const onStop = rs.fn();
    const { onSend } = renderComposer({ isStreaming: true, onStop });
    const box = screen.getByPlaceholderText("Message") as HTMLTextAreaElement;
    const stop = screen.getByRole("button", { name: "Stop generating" });
    expect((stop as HTMLButtonElement).disabled).toBe(false);

    await userEvent.type(box, "next question");
    await userEvent.click(stop);

    expect(onStop).toHaveBeenCalledTimes(1);
    expect(onSend).not.toHaveBeenCalled();
    expect(box.value).toBe("next question");
    await userEvent.type(box, "{Enter}");
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect(onSend.mock.calls[0][0]).toMatchObject({ text: "next question" });
  });

  it("lets the keyboard stop a turn with an empty draft", async () => {
    const onStop = rs.fn();
    const { onSend } = renderComposer({ isStreaming: true, onStop });
    screen.getByRole("button", { name: "Stop generating" }).focus();
    await userEvent.keyboard("{Enter}");
    expect(onStop).toHaveBeenCalledTimes(1);
    expect(onSend).not.toHaveBeenCalled();
  });

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

  it.each([true, false])("opens the model submenu with selector=%s", async (selector) => {
    const onChange = rs.fn();
    renderComposer({ modelSelection: { value: "claude-sonnet", onChange } }, undefined, selector);
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
    expect(onSend.mock.calls[0][0]).toMatchObject({
      text: "why there?",
      replyTo: reply,
    });
    expect(screen.queryByRole("button", { name: "Cancel reply" })).toBeNull();
  });

  it("leaves the thread reply's own placeholder alone in a named topic chat", async () => {
    renderComposer({ chatName: "Trip to Lisbon" }, undefined, true, undefined, true);
    expect(await screen.findByPlaceholderText("Reply")).toBeTruthy();
  });

  it("sends every message into its thread, quoting a message only when one is picked", async () => {
    const { onSend } = renderComposer({}, reply, true, undefined, true);

    // The thread tab's composer reads as a reply into the thread.
    await userEvent.type(await screen.findByPlaceholderText("Reply"), "why there?{Enter}");
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    await userEvent.type(screen.getByPlaceholderText("Reply"), "and the hotel?{Enter}");
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(2));

    expect(onSend.mock.calls[0][0]).toMatchObject({ chatThread: "a1", replyTo: reply });
    // The send cleared the reply, not the thread.
    expect(onSend.mock.calls[1][0]).toMatchObject({ chatThread: "a1" });
    expect(onSend.mock.calls[1][0].replyTo).toBeUndefined();
    expect(screen.queryByRole("button", { name: "Cancel reply" })).toBeNull();
    expect(screen.getByPlaceholderText("Reply")).toBeTruthy();
  });

  it("keeps sending into its thread, with its reply back, when a send fails", async () => {
    const { onSend } = renderComposer({}, reply, true, undefined, true);
    onSend.mockRejectedValueOnce(new Error("offline"));

    await userEvent.type(await screen.findByPlaceholderText("Reply"), "why there?{Enter}");
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole("button", { name: "Cancel reply" })).toBeTruthy();
    await userEvent.type(screen.getByPlaceholderText("Reply"), "{Enter}");
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(2));

    expect(onSend.mock.calls[1][0]).toMatchObject({ chatThread: "a1", replyTo: reply });
  });

  it("drops a picked reply on Esc and keeps sending into its thread", async () => {
    const { onSend } = renderComposer({}, reply, true, undefined, true);
    await screen.findByRole("button", { name: "Cancel reply" });

    await userEvent.type(screen.getByPlaceholderText("Reply"), "{Escape}");
    expect(screen.queryByRole("button", { name: "Cancel reply" })).toBeNull();
    await userEvent.type(screen.getByPlaceholderText("Reply"), "ok{Enter}");

    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect(onSend.mock.calls[0][0]).toMatchObject({ chatThread: "a1" });
    expect(onSend.mock.calls[0][0].replyTo).toBeUndefined();
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

  describe("choosing a folder", () => {
    const openPicker = async () => {
      await userEvent.click(screen.getByRole("button", { name: "Add files or change the model" }));
      await userEvent.click(await screen.findByRole("menuitem", { name: /Choose folder/ }));
      return screen.findByRole("combobox");
    };
    const pickDeviceFolder = async () => {
      await openPicker();
      await userEvent.click(await screen.findByRole("option", { name: /workstation/ }));
      await userEvent.click(await screen.findByRole("button", { name: "Use this folder" }));
    };
    const deviceLine = '- Folder: "/home/alex" on Rome node device "workstation" (id 0f3c)';
    // The placeholder changes once a file is attached, so find it by role.
    const box = () => screen.getByRole("textbox") as HTMLTextAreaElement;

    it("opens the selector from the + menu with focus in its search field, and keeps it open", async () => {
      renderComposer();
      const search = await openPicker();
      await waitFor(() => expect(document.activeElement).toBe(search));
      expect(await screen.findByRole("option", { name: /Rome Cloud/ })).toBeTruthy();
      expect(screen.getByRole("option", { name: /workstation/ })).toBeTruthy();
      // No new-project row in this selector.
      expect(screen.queryByText("Create project")).toBeNull();
      expect(screen.queryByRole("menuitem")).toBeNull();
    });

    it("sends a device folder as a line of text and clears the chip", async () => {
      const { onSend } = renderComposer();
      await pickDeviceFolder();
      expect(await screen.findByRole("button", { name: "Remove folder" })).toBeTruthy();

      await userEvent.type(box(), "run the tests{Enter}");

      await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
      expect(onSend.mock.calls[0][0].text).toBe(`run the tests\n\n${deviceLine}`);
      expect(screen.queryByRole("button", { name: "Remove folder" })).toBeNull();
    });

    it("sends a Rome project by its path, and nothing once the chip is removed", async () => {
      const { onSend } = renderComposer();
      await openPicker();
      await userEvent.click(await screen.findByRole("option", { name: /Rome Cloud/ }));
      await userEvent.click(await screen.findByRole("option", { name: /app/ }));
      await userEvent.type(box(), "hi{Enter}");
      await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
      expect(onSend.mock.calls[0][0].text).toBe(
        'hi\n\n- Folder: "/home/alex/.rome/default/projects/app" (Rome project "app")',
      );

      await pickDeviceFolder();
      await userEvent.click(await screen.findByRole("button", { name: "Remove folder" }));
      await userEvent.type(box(), "again{Enter}");
      await waitFor(() => expect(onSend).toHaveBeenCalledTimes(2));
      expect(onSend.mock.calls[1][0].text).toBe("again");
    });

    it("sends a folder alone, and puts the folder back when the send fails", async () => {
      const { onSend } = renderComposer();
      onSend.mockRejectedValueOnce(new Error("offline"));
      await pickDeviceFolder();

      await userEvent.click(screen.getByRole("button", { name: "Send" }));
      await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
      expect(onSend.mock.calls[0][0].text).toBe(deviceLine);
      expect(await screen.findByRole("button", { name: "Remove folder" })).toBeTruthy();

      await userEvent.type(box(), "retry{Enter}");
      await waitFor(() => expect(onSend).toHaveBeenCalledTimes(2));
      expect(onSend.mock.calls[1][0].text).toBe(`retry\n\n${deviceLine}`);
    });

    it("keeps the text, the attachments and the folder when a send with files fails", async () => {
      const { onSend } = renderComposer();
      onSend.mockRejectedValueOnce(new Error("offline"));
      await pickDeviceFolder();
      const file = new File(["x"], "notes.txt", { type: "text/plain" });
      await userEvent.upload(
        document.querySelector('input[type="file"]') as HTMLInputElement,
        file,
      );
      await userEvent.type(box(), "see notes{Enter}");

      await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
      expect(onSend.mock.calls[0][0].uploads).toHaveLength(1);
      expect(box().value).toBe("see notes");
      expect(await screen.findByRole("button", { name: "Remove folder" })).toBeTruthy();
      expect(screen.getByText("notes.txt")).toBeTruthy();
    });
  });
});
