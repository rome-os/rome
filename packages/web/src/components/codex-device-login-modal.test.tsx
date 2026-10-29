// @rstest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render as renderReact, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, expect, it, rs } from "@rstest/core";
import { render } from "@/test/query-render";
import i18n from "@/i18n";
import { AI_TOOL_STATUS_QUERY_KEY } from "@/hooks/use-ai-tool-status";
import { CodexDeviceLoginModal } from "./codex-device-login-modal";

let CONFIRM = "";
beforeAll(async () => {
  await i18n.changeLanguage("en");
  CONFIRM = i18n.t("codexDeviceLogin.enable.confirm", { ns: "onboard" });
});
afterEach(() => {
  cleanup();
  rs.restoreAllMocks();
});
it("detects a device login completing through the shared cache poll", async () => {
  let loggedIn = false;
  const onConnected = rs.fn();
  rs.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    if (String(input) === "/api/ai-tools/status") return Response.json({ codex: { loggedIn } });
    return Response.json({ userCode: "TEST-CODE", verificationUrl: "https://example.com/verify" });
  });
  render(<CodexDeviceLoginModal open onClose={() => {}} onConnected={onConnected} />);
  loggedIn = true;
  await waitFor(() => expect(onConnected).toHaveBeenCalledTimes(1), { timeout: 5000 });
});

it("does not bring back a cancelled attempt's code or error from the shared cache", async () => {
  rs.spyOn(globalThis, "fetch").mockImplementation((input) => {
    if (String(input) === "/api/ai-tools/status")
      return Promise.resolve(Response.json({ codex: { loggedIn: false } }));
    // The new attempt's start is still in flight.
    return new Promise<Response>(() => {});
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(AI_TOOL_STATUS_QUERY_KEY, {
    codex: { loggedIn: false },
    codexDeviceLogin: {
      running: true,
      userCode: "OLD-CODE",
      verificationUrl: "https://example.com/verify",
      lastError: "previous attempt expired",
    },
  });
  renderReact(
    <QueryClientProvider client={client}>
      <CodexDeviceLoginModal open onClose={() => {}} onConnected={() => {}} />
    </QueryClientProvider>,
  );
  await userEvent.click(await screen.findByRole("button", { name: CONFIRM }));
  await new Promise((done) => setTimeout(done, 100));
  expect(screen.queryByText("OLD-CODE")).toBeNull();
  expect(screen.queryByText("previous attempt expired")).toBeNull();
});
