// @rstest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, rs } from "@rstest/core";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import i18n from "@/i18n";
import SettingsPage from "./SettingsTabPage";

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

afterEach(() => {
  cleanup();
  rs.restoreAllMocks();
});

function ok(json: unknown): Response {
  return new Response(JSON.stringify(json), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function failed(status: number, error: string): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function mockConnectionsFetch(
  loadConnections: () => Response | Promise<Response>,
): ReturnType<typeof rs.spyOn> {
  return rs.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/approvals") return new Response("[]", { status: 200 });
    if (url === "/api/settings") return ok({});
    if (url === "/api/integrations/composio/status") return ok({});
    if (url === "/api/connections") return loadConnections();
    return ok({});
  }) as typeof fetch);
}

function renderConnectionsSettings() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/settings/connections"]}>
        <Routes>
          <Route path="/settings/:tab" element={<SettingsPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("Settings connections request states", () => {
  it("shows connection row skeletons while the registry request is pending", async () => {
    mockConnectionsFetch(() => new Promise<Response>(() => {}));

    renderConnectionsSettings();

    expect(await screen.findByLabelText("Loading connections")).toBeTruthy();
  });

  it("shows a failed registry request with a retry that reloads the connections", async () => {
    let connectionLoads = 0;
    rs.spyOn(console, "error").mockImplementation(() => {});
    mockConnectionsFetch(() => {
      connectionLoads += 1;
      if (connectionLoads === 1) return failed(503, "Connections service unavailable");
      return ok({
        connections: [
          {
            id: null,
            state: null,
            connectionKind: "email",
            label: "Email",
            grants: { inbox: "unauthorized" },
            display: {},
            setups: {},
            capabilities: {
              chat: { state: "unsupported" },
              act: { state: "unsupported" },
              watch: { state: "unsupported" },
            },
            connect: null,
          },
        ],
      });
    });

    renderConnectionsSettings();

    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("Connections service unavailable")).toBeTruthy();

    await userEvent.click(within(alert).getByRole("button", { name: "Retry" }));

    expect(await screen.findByRole("button", { name: "Open Email" })).toBeTruthy();
    expect(connectionLoads).toBe(2);
  });

  it("shows a real empty state when the registry request succeeds without connections", async () => {
    mockConnectionsFetch(() => ok({ connections: [] }));

    renderConnectionsSettings();

    expect(await screen.findByText("No connections available")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("keeps the members switch as its change left it when an older poll answers after the change's refresh", async () => {
    const feishu = (answerMembers: boolean) => ({
      connections: [
        {
          id: "conn-feishu",
          state: "connected",
          connectionKind: "feishu",
          label: "Feishu",
          channel: "feishu",
          grants: { app: "authorized" },
          display: {
            app: { displayName: "Support Bot", handle: null, email: null, avatarUrl: null },
          },
          setups: {},
          capabilities: {
            chat: { state: "unlocked" },
            act: { state: "unsupported" },
            watch: { state: "unsupported" },
          },
          connect: null,
          agent: null,
          severalAccounts: true,
          answerMembers,
        },
      ],
    });
    // The poll's answer is held until after the change's refresh lands.
    let answerPoll: (response: Response) => void = () => {};
    let loads = 0;
    rs.spyOn(globalThis, "fetch").mockImplementation((async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const url = String(input);
      if (url === "/api/approvals") return new Response("[]", { status: 200 });
      if (url === "/api/settings") return ok({});
      if (url === "/api/integrations/composio/status") return ok({});
      if (url.endsWith("/answer-members") && init?.method === "PUT") {
        return ok({ answerMembers: true });
      }
      if (url === "/api/connections") {
        loads += 1;
        if (loads === 2) return new Promise<Response>((resolve) => (answerPoll = resolve));
        return ok(feishu(loads > 2));
      }
      return ok({});
    }) as typeof fetch);
    const polls: Array<() => void> = [];
    const setInterval = window.setInterval.bind(window);
    rs.spyOn(window, "setInterval").mockImplementation(((handler: TimerHandler, ms?: number) => {
      if (typeof handler === "function") polls.push(handler as () => void);
      return setInterval(() => {}, ms);
    }) as typeof window.setInterval);

    renderConnectionsSettings();
    await userEvent.click(await screen.findByRole("button", { name: /^Open Feishu/ }));
    const toggle = () =>
      screen.getByRole("switch", { name: "Answer other members of this workspace" });
    expect(toggle().getAttribute("aria-checked")).toBe("false");

    // A poll starts before the change, and its answer is the state before it.
    for (const poll of polls) poll();
    await userEvent.click(toggle());
    await screen.findByRole("switch", { checked: true });
    await waitFor(() => expect(loads).toBe(3));
    await waitFor(() => expect((toggle() as HTMLButtonElement).disabled).toBe(false));
    answerPoll(ok(feishu(false)));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(toggle().getAttribute("aria-checked")).toBe("true");
  });
});
