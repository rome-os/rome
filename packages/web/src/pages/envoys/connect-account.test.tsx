// @rstest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, rs } from "@rstest/core";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { MAIN_AGENT_ID } from "@rome/api-types/account-agents";
import i18n from "@/i18n";
import type { ApiConnection } from "@/lib/connections-api";
import EnvoysPage from "./EnvoysPage";

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

afterEach(() => {
  cleanup();
  rs.restoreAllMocks();
});

function connection(service: string, overrides: Partial<ApiConnection> = {}): ApiConnection {
  return {
    id: `${service}-id`,
    service,
    label: service,
    grants: { bot: "authorized" },
    display: { bot: { displayName: service } },
    capabilities: {
      talk: { state: "unlocked" },
      act: { state: "unsupported" },
      watch: { state: "unsupported" },
    },
    connect: null,
    setups: {},
    channel: service,
    agent: MAIN_AGENT_ID,
    severalAccounts: true,
    ...overrides,
  } as ApiConnection;
}

/** A placeholder for a service with nothing connected. */
const placeholder = (service: string) =>
  connection(service, { id: null, channel: null, grants: { bot: "unauthorized" }, agent: null });

type Call = { url: string; method: string; body: unknown };

/** Serves the connections and agents. A setup finishes at once and adds the
 *  account `added` names, with the agent core gives it. */
function mockServer(
  connections: ApiConnection[],
  added: { id: string; service: string; agent: string | null } | null,
) {
  const calls: Call[] = [];
  rs.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method, body });
    if (url === "/api/agents") {
      return Response.json({ agents: [{ name: "main" }, { name: "sales:agent" }] });
    }
    if (url === "/api/connections") return Response.json({ connections });
    if (url.endsWith("/setup") && method === "POST") {
      if (added) {
        connections.push(
          connection(added.service, { id: added.id, channel: added.id, agent: added.agent }),
        );
      }
      return Response.json({
        cid: "cid-new",
        state: { status: "done", conferral: added ? { connectionId: added.id } : {} },
        reattached: false,
      });
    }
    const link = url.match(/^\/api\/channels\/accounts\/(.+)\/agent$/);
    if (link && method === "PUT") {
      const account = connections.find((c) => c.channel === decodeURIComponent(link[1]!))!;
      account.agent = (body as { agent: string | null }).agent;
      return Response.json({ account: {} });
    }
    if (url === "/api/approvals") return Response.json([]);
    return new Response("not found", { status: 404 });
  });
  return calls;
}

function Location() {
  return <output data-testid="location">{useLocation().pathname}</output>;
}

function renderAt(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/envoys/*" element={<EnvoysPage />} />
          <Route path="*" element={null} />
        </Routes>
        <Location />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const location = () => screen.getByTestId("location").textContent;

describe("Connect an account", () => {
  it("picks the agent, then the platform", async () => {
    mockServer([connection("discord")], null);
    renderAt("/envoys");
    const user = userEvent.setup();

    await user.click(await screen.findByRole("link", { name: "Connect an account" }));
    await user.click(await screen.findByRole("link", { name: "sales:agent" }));
    await user.click(await screen.findByRole("link", { name: "Discord" }));

    expect(location()).toBe(`/envoys/connect/${encodeURIComponent("sales:agent")}/discord`);
    expect(await screen.findByRole("button", { name: "Connect" })).toBeTruthy();
  });

  it("connects another account and links the picked agent to it", async () => {
    const calls = mockServer([connection("discord")], {
      id: "discord-2",
      service: "discord",
      agent: null,
    });
    renderAt("/envoys/connect/sales:agent/discord");
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Connect" }));

    await rs.waitFor(() => expect(location()).toBe(`/envoys/${encodeURIComponent("sales:agent")}`));
    expect(calls.find((call) => call.url.endsWith("/setup"))).toMatchObject({
      url: "/api/connections/discord/grants/bot/setup",
      body: { another: true },
    });
    expect(calls.filter((call) => call.method === "PUT")).toEqual([
      {
        url: "/api/channels/accounts/discord-2/agent",
        method: "PUT",
        body: { agent: "sales:agent" },
      },
    ]);
  });

  it("connects a service's first account in place of its placeholder", async () => {
    const calls = mockServer([placeholder("telegram")], {
      id: "telegram-id",
      service: "telegram",
      agent: MAIN_AGENT_ID,
    });
    renderAt("/envoys/connect/main/telegram");
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Connect" }));

    await rs.waitFor(() => expect(location()).toBe(`/envoys/${encodeURIComponent(MAIN_AGENT_ID)}`));
    const setup = calls.find((call) => call.url.endsWith("/setup"));
    expect(setup?.url).toBe("/api/connections/telegram/grants/bot/setup");
    expect(setup?.body).not.toHaveProperty("another");
    // Core already linked main to the service's first account.
    expect(calls.filter((call) => call.method === "PUT")).toEqual([]);
  });

  it("returns to the list when the new account cannot be found to link", async () => {
    mockServer([connection("discord")], null);
    renderAt("/envoys/connect/sales:agent/discord");
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Connect" }));

    await rs.waitFor(() => expect(location()).toBe("/envoys"));
  });

  it("offers no platform whose one account is already connected", async () => {
    mockServer(
      [
        connection("discord"),
        connection("telegram_user", {
          grants: { session: "authorized" },
          display: { session: null },
          severalAccounts: false,
        }),
      ],
      null,
    );
    renderAt("/envoys/connect/main");

    expect(await screen.findByText("Your own account")).toBeTruthy();
    expect(screen.queryByRole("link", { name: /Your Telegram/ })).toBeNull();
    expect(screen.getByText(/Already connected/)).toBeTruthy();
  });
});
