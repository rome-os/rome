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

function connection(service: string, name: string, agent: string | null): ApiConnection {
  return {
    id: `${service}-id`,
    service,
    label: service,
    grants: { bot: "authorized" },
    display: { bot: { displayName: name } },
    capabilities: {
      talk: { state: "unlocked" },
      act: { state: "unsupported" },
      watch: { state: "unsupported" },
    },
    connect: null,
    setups: {},
    channel: service,
    agent,
  } as ApiConnection;
}

/** Serves the connections and agents, and applies each link the way core
 *  does, so the refetch after a change moves the account. */
function mockServer(connections: ApiConnection[]) {
  rs.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    if (url === "/api/agents") {
      return Response.json({ agents: [{ name: "main" }, { name: "sales:agent" }] });
    }
    if (url === "/api/connections") return Response.json({ connections });
    const link = url.match(/^\/api\/channels\/accounts\/(.+)\/agent$/);
    if (link && init?.method === "PUT") {
      const { agent } = JSON.parse(String(init.body)) as { agent: string | null };
      const account = connections.find((c) => c.channel === decodeURIComponent(link[1]!))!;
      account.agent = agent;
      return Response.json({ account: {}, unlinkedFrom: null });
    }
    return new Response("not found", { status: 404 });
  });
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

async function pick(account: string, option: string) {
  const user = userEvent.setup();
  const select = await screen.findByRole("combobox", { name: `Agent for ${account}` });
  await rs.waitFor(() => expect(select.hasAttribute("disabled")).toBe(false));
  await user.click(select);
  await user.click(await screen.findByRole("option", { name: option }));
  return user;
}

const location = () => screen.getByTestId("location").textContent;

describe("EnvoysPage", () => {
  it("opens the agent's page after linking an unlinked account", async () => {
    mockServer([connection("discord", "Sales", null)]);
    renderAt("/envoys");

    await pick("Sales", "sales:agent");

    await rs.waitFor(() => expect(location()).toBe(`/envoys/${encodeURIComponent("sales:agent")}`));
  });

  it("links an account's name to its Connections card", async () => {
    mockServer([connection("discord", "Sales", null)]);
    renderAt("/envoys");

    const link = await screen.findByRole("link", { name: "Sales" });
    expect(link.getAttribute("href")).toBe("/settings/connections/discord");
  });

  it("stays on Settings while the agent keeps other accounts", async () => {
    mockServer([
      connection("discord", "Sales", "sales:agent"),
      connection("feishu", "Ops", "sales:agent"),
    ]);
    renderAt("/envoys/sales:agent/settings");

    const user = await pick("Sales", "No agent");
    await user.click(screen.getByRole("button", { name: "Unlink" }));

    await rs.waitFor(() =>
      expect(screen.queryByRole("combobox", { name: "Agent for Sales" })).toBeNull(),
    );
    expect(location()).toBe("/envoys/sales:agent/settings");
  });

  it("follows the agent's last account to its new agent", async () => {
    mockServer([connection("discord", "Sales", "sales:agent")]);
    renderAt("/envoys/sales:agent/settings");

    const user = await pick("Sales", "main");
    await user.click(screen.getByRole("button", { name: "Switch agent" }));

    await rs.waitFor(() =>
      expect(location()).toBe(`/envoys/${encodeURIComponent(MAIN_AGENT_ID)}/settings`),
    );
  });
});
