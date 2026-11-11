// @rstest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, rs } from "@rstest/core";
import { CONCIERGE_SESSION_QUERY_KEY, useConciergeChat, useConciergeName } from "./use-concierge";

function Name() {
  return <output>{useConciergeName()}</output>;
}

function renderName(settings: Record<string, unknown>) {
  rs.spyOn(globalThis, "fetch").mockImplementation((async () =>
    Response.json(settings)) as typeof fetch);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <Name />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  rs.restoreAllMocks();
});

describe("useConciergeChat", () => {
  function Main() {
    const main = useConciergeChat();
    return <output>{`${main.chatId ?? "none"} ${main.failed ? "failed" : "ok"}`}</output>;
  }

  it("keeps the loaded main chat when a later refetch fails", async () => {
    let fail = false;
    rs.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) => {
      if (String(input) !== "/api/concierge/session") return new Response(null, { status: 204 });
      return fail
        ? Response.json({ error: "down" }, { status: 500 })
        : Response.json({ id: "concierge", unread: 0 });
    }) as typeof fetch);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <Main />
      </QueryClientProvider>,
    );
    expect(await screen.findByText("concierge ok")).toBeTruthy();

    fail = true;
    await act(() => client.refetchQueries({ queryKey: CONCIERGE_SESSION_QUERY_KEY }));
    await waitFor(() =>
      expect(client.getQueryState(CONCIERGE_SESSION_QUERY_KEY)?.status).toBe("error"),
    );
    expect(screen.getByRole("status").textContent).toBe("concierge ok");
  });

  it("fails when the first load fails", async () => {
    rs.spyOn(globalThis, "fetch").mockImplementation((async () =>
      Response.json({ error: "down" }, { status: 500 })) as typeof fetch);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <Main />
      </QueryClientProvider>,
    );
    expect(await screen.findByText("none failed")).toBeTruthy();
  });
});

describe("useConciergeName", () => {
  it("is the trimmed agent name the guardian chose", async () => {
    renderName({ agentName: "  Milo " });
    expect(await screen.findByText("Milo")).toBeTruthy();
  });

  it.each([
    ["unset", {}],
    ["blank", { agentName: "   " }],
    ["not text", { agentName: 7 }],
  ])("falls back to Concierge when the agent name is %s", async (_label, settings) => {
    renderName(settings);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.getByRole("status").textContent).toBe("Concierge");
  });
});
