// @rstest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, rs } from "@rstest/core";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router-dom";
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
    connectionKind: service,
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
function mockServer(
  connections: ApiConnection[],
  beforeLink: () => Promise<void> = async () => {},
) {
  rs.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    if (url === "/api/agents") {
      return Response.json({ agents: [{ name: "main" }, { name: "sales:agent" }] });
    }
    if (url === "/api/connections") return Response.json({ connections });
    const link = url.match(/^\/api\/channels\/accounts\/(.+)\/agent$/);
    if (link && init?.method === "PUT") {
      await beforeLink();
      const { agent } = JSON.parse(String(init.body)) as { agent: string | null };
      const account = connections.find((c) => c.channel === decodeURIComponent(link[1]!))!;
      account.agent = agent;
      return Response.json({ account: {} });
    }
    const revoke = url.match(/^\/api\/connections\/(.+)\/grants\/.+$/);
    if (revoke && init?.method === "DELETE") {
      const index = connections.findIndex((c) => c.id === decodeURIComponent(revoke[1]!));
      connections.splice(index, 1);
      return new Response(null, { status: 204 });
    }
    return new Response("not found", { status: 404 });
  });
}

function Location() {
  const navigate = useNavigate();
  return (
    <>
      <output data-testid="location">{useLocation().pathname}</output>
      <button type="button" onClick={() => navigate("/elsewhere")}>
        Leave
      </button>
    </>
  );
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

  it("does not pull the guardian back once they have left Envoys", async () => {
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const linked = rs.fn();
    mockServer([connection("discord", "Sales", null)], async () => {
      linked();
      await held;
    });
    renderAt("/envoys");

    const user = await pick("Sales", "sales:agent");
    await rs.waitFor(() => expect(linked).toHaveBeenCalled());
    await user.click(screen.getByRole("button", { name: "Leave" }));
    release();

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(location()).toBe("/elsewhere");
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

  it("returns to the list after disconnecting the agent's last account", async () => {
    mockServer([connection("discord", "Sales", "sales:agent")]);
    renderAt("/envoys/sales:agent/settings");
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Disconnect Sales" }));
    await user.click(screen.getByRole("button", { name: "Disconnect" }));

    await rs.waitFor(() => expect(location()).toBe("/envoys"));
  });

  it("stays on Settings after disconnecting one of the agent's accounts", async () => {
    mockServer([
      connection("discord", "Sales", "sales:agent"),
      connection("telegram", "Sales TG", "sales:agent"),
    ]);
    renderAt("/envoys/sales:agent/settings");
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Disconnect Sales" }));
    await user.click(screen.getByRole("button", { name: "Disconnect" }));

    await rs.waitFor(() =>
      expect(screen.queryByRole("button", { name: "Disconnect Sales" })).toBeNull(),
    );
    expect(screen.getByRole("button", { name: "Disconnect Sales TG" })).toBeTruthy();
    expect(location()).toBe("/envoys/sales:agent/settings");
  });
});
