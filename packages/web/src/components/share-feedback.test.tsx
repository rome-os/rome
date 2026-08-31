// @rstest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, rs } from "@rstest/core";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import i18n from "@/i18n";
import { ThemeProvider } from "@/hooks/use-theme";
import { ShareFeedbackDialog } from "./share-feedback";

beforeAll(async () => {
  await i18n.changeLanguage("en");
  // Radix/jsdom polyfills for pointer/scroll events used by Dialog.
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
  Element.prototype.scrollIntoView = () => {};
});

afterEach(() => {
  cleanup();
  rs.restoreAllMocks();
});

function renderDialog(onClose: () => void = () => {}) {
  return render(
    <ThemeProvider>
      <MemoryRouter initialEntries={["/chat"]}>
        <ShareFeedbackDialog open onClose={onClose} />
      </MemoryRouter>
    </ThemeProvider>,
  );
}

describe("ShareFeedbackDialog", () => {
  it("given an open dialog, then it shows a text field", async () => {
    renderDialog();

    expect(await screen.findByRole("textbox")).toBeTruthy();
  });

  it("given an empty field, when the dialog is open, then submit is disabled", async () => {
    renderDialog();
    await screen.findByRole("textbox");

    const send = screen.getByRole("button", { name: /^send$/i }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
  });

  it("given typed feedback, when submitted, then it POSTs the body plus client context (route, theme) to /api/feedback and closes", async () => {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    rs.spyOn(globalThis, "fetch").mockImplementation((async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      calls.push({
        url: String(input),
        body: init?.body ? JSON.parse(String(init.body)) : {},
      });
      return { ok: true, status: 201, json: async () => ({ ok: true }) } as Response;
    }) as typeof fetch);

    const onClose = rs.fn();
    const user = userEvent.setup();
    renderDialog(onClose);

    await user.type(await screen.findByRole("textbox"), "love it");
    await user.click(screen.getByRole("button", { name: /^send$/i }));

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0].url).toBe("/api/feedback");
    expect(calls[0].body.body).toBe("love it");
    const client = calls[0].body.client as Record<string, unknown>;
    expect(client.route).toBe("/chat");
    expect(client).toHaveProperty("theme");
    expect(client).toHaveProperty("viewport");
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });
});
