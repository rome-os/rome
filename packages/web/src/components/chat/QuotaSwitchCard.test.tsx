// @rstest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, expect, it, rs } from "@rstest/core";
import i18n from "@/i18n";
import { QuotaSwitchCard } from "./QuotaSwitchCard";

beforeAll(() => i18n.changeLanguage("en"));
afterEach(() => {
  cleanup();
  rs.restoreAllMocks();
});

function mount(
  target: unknown,
  post: () => Promise<Response> = async () =>
    Response.json({ id: "chat", largeModelSelection: "gpt-6-luna" }),
) {
  const fetch = rs
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (_url, init) =>
      init?.method === "POST" ? post() : Response.json({ target }),
    );
  const onSwitched = rs.fn(async () => {});
  const onRefused = rs.fn();
  render(
    <QueryClientProvider client={new QueryClient()}>
      <QuotaSwitchCard sessionId="chat" onSwitched={onSwitched} onRefused={onRefused} />
    </QueryClientProvider>,
  );
  return { fetch, onSwitched, onRefused };
}

it("renders nothing when no target exists", async () => {
  const { fetch } = mount(null);
  await waitFor(() => expect(fetch).toHaveBeenCalled());
  expect(screen.queryByRole("button")).toBeNull();
});
it.each(["openai", "anthropic"])("labels the one action for %s", async (provider) => {
  mount({ provider, selectionId: "model" });
  expect(
    await screen.findByRole("button", {
      name:
        provider === "openai" ? "Switch to Codex and continue" : "Switch to Claude and continue",
    }),
  ).toBeTruthy();
});
it("disables during the POST and reports one successful switch", async () => {
  let resolve!: (response: Response) => void;
  const { fetch, onSwitched } = mount(
    { provider: "openai", selectionId: "gpt-6-luna" },
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  const button = await screen.findByRole("button");
  fireEvent.click(button);
  fireEvent.click(button);
  expect((button as HTMLButtonElement).disabled).toBe(true);
  expect(fetch.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  await act(async () => resolve(Response.json({ id: "chat", largeModelSelection: "gpt-6-luna" })));
  await waitFor(() => expect(onSwitched).toHaveBeenCalledTimes(1));
});
it("hides a refused offer and never continues", async () => {
  const { onSwitched, onRefused } = mount(
    { provider: "openai", selectionId: "gpt-6-luna" },
    async () => Response.json({ error: "No quota switch available" }, { status: 409 }),
  );
  fireEvent.click(await screen.findByRole("button"));
  await waitFor(() => expect(onRefused).toHaveBeenCalledTimes(1));
  expect(onSwitched).not.toHaveBeenCalled();
  expect(screen.queryByRole("button")).toBeNull();
});
