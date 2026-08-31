// @rstest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, rs } from "@rstest/core";
import i18n from "@/i18n";
import { ChatGPTLoginModal } from "./chatgpt-login-modal";

beforeAll(async () => {
  await i18n.changeLanguage("en");
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
  Element.prototype.scrollIntoView = () => {};
});

afterEach(() => {
  cleanup();
  rs.restoreAllMocks();
});

describe("ChatGPTLoginModal", () => {
  it("shows an asynchronous browser-login failure returned by AI tool status", async () => {
    rs.spyOn(globalThis, "fetch").mockImplementation((async (input, init) => {
      const url = String(input);
      if (url === "/api/desktop/navigate-chatgpt" && init?.method === "POST") {
        return Response.json({ ok: true });
      }
      if (url === "/api/ai-tools/codex/login/start" && init?.method === "POST") {
        return Response.json({ started: true });
      }
      if (url === "/api/ai-tools/status") {
        return Response.json({
          codex: { loggedIn: false },
          codexLogin: {
            running: false,
            lastError: "authorization declined",
          },
        });
      }
      throw new Error(`unexpected request: ${url}`);
    }) as typeof fetch);

    render(<ChatGPTLoginModal open onClose={() => {}} onConnected={() => {}} />);

    await userEvent.click(await screen.findByRole("button", { name: "I've logged in" }));

    expect(await screen.findByText("authorization declined")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Back" })).toBeTruthy();
  });
});
