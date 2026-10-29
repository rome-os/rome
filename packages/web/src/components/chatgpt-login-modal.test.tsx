// @rstest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render as renderReact, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, rs } from "@rstest/core";
import { render } from "@/test/query-render";
import i18n from "@/i18n";
import { AI_TOOL_STATUS_QUERY_KEY } from "@/hooks/use-ai-tool-status";
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
  it("ignores an earlier attempt's error still held in the shared status cache", async () => {
    rs.spyOn(globalThis, "fetch").mockImplementation((async (input) => {
      if (String(input) === "/api/ai-tools/status") {
        return Response.json({ codex: { loggedIn: false }, codexLogin: { running: true } });
      }
      return Response.json({ ok: true, started: true });
    }) as typeof fetch);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(AI_TOOL_STATUS_QUERY_KEY, {
      codex: { loggedIn: false },
      codexLogin: { running: false, lastError: "previous attempt failed" },
    });
    renderReact(
      <QueryClientProvider client={client}>
        <ChatGPTLoginModal open onClose={() => {}} onConnected={() => {}} />
      </QueryClientProvider>,
    );
    await userEvent.click(await screen.findByRole("button", { name: "I've logged in" }));
    await new Promise((done) => setTimeout(done, 300));
    expect(screen.queryByText("previous attempt failed")).toBeNull();
  });
});
