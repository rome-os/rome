// @rstest-environment jsdom
import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, rs } from "@rstest/core";
import { render } from "@/test/query-render";
import i18n from "@/i18n";
import { ChatGPTLoginModal } from "./chatgpt-login-modal";

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

afterEach(() => {
  cleanup();
  rs.restoreAllMocks();
});

describe("ChatGPTLoginModal", () => {
  it("keeps detecting a completed browser login through the shared cache poll", async () => {
    let loggedIn = false;
    const onConnected = rs.fn();
    rs.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      if (String(input) === "/api/ai-tools/status") return Response.json({ codex: { loggedIn } });
      return Response.json({ ok: true, started: true });
    });
    render(<ChatGPTLoginModal open onClose={() => {}} onConnected={onConnected} />);
    await userEvent.click(await screen.findByRole("button", { name: "I've logged in" }));
    loggedIn = true;
    await waitFor(() => expect(onConnected).toHaveBeenCalledTimes(1), { timeout: 3500 });
  });

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
