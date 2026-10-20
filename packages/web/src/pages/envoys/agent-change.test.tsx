// @rstest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, rs } from "@rstest/core";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MAIN_AGENT_ID } from "@rome/api-types/account-agents";
import i18n from "@/i18n";
import { AgentChange } from "./agent-change";
import type { Envoy, EnvoyAccount } from "./envoys-model";

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

afterEach(() => {
  cleanup();
  rs.restoreAllMocks();
});

function account(overrides: Partial<EnvoyAccount> = {}): EnvoyAccount {
  return {
    channel: "discord",
    service: "discord",
    platform: "discord",
    name: "Sales",
    kind: "own",
    agent: null,
    route: "discord",
    ...overrides,
  };
}

function mockLink() {
  const puts: { url: string; body: unknown }[] = [];
  rs.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    puts.push({ url: String(input), body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify({ account: {}, unlinkedFrom: null }), { status: 200 });
  });
  return puts;
}

function renderChange(props: {
  account: EnvoyAccount;
  envoys?: Envoy[];
  onChanged?: (agent: string | null) => void;
}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <AgentChange
        account={props.account}
        envoys={props.envoys ?? []}
        agents={[MAIN_AGENT_ID, "sales:agent"]}
        agentsFailed={false}
        onChanged={props.onChanged ?? (() => {})}
      >
        {props.account.name}
      </AgentChange>
    </QueryClientProvider>,
  );
}

async function pick(option: string) {
  const user = userEvent.setup();
  await user.click(screen.getByRole("combobox", { name: "Agent for Sales" }));
  await user.click(await screen.findByRole("option", { name: option }));
  return user;
}

describe("AgentChange", () => {
  it("links an agent to an account with none in one step", async () => {
    const puts = mockLink();
    const onChanged = rs.fn();
    renderChange({ account: account(), onChanged });
    expect(screen.getByRole("combobox", { name: "Agent for Sales" }).textContent).toContain(
      "Link an agent",
    );

    await pick("sales:agent");

    await waitFor(() => expect(onChanged).toHaveBeenCalledWith("sales:agent"));
    expect(puts).toEqual([
      { url: "/api/channels/accounts/discord/agent", body: { agent: "sales:agent" } },
    ]);
  });

  it("asks before switching, and switches on confirm", async () => {
    const puts = mockLink();
    const onChanged = rs.fn();
    renderChange({ account: account({ agent: MAIN_AGENT_ID }), onChanged });

    const user = await pick("sales:agent");
    expect(screen.getByText(/answers in every chat the account is in/)).toBeTruthy();
    expect(puts).toEqual([]);

    await user.click(screen.getByRole("button", { name: "Switch agent" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledWith("sales:agent"));
    expect(puts[0]?.body).toEqual({ agent: "sales:agent" });
  });

  it("unlinks with null after confirming", async () => {
    const puts = mockLink();
    const onChanged = rs.fn();
    renderChange({ account: account({ agent: "sales:agent" }), onChanged });

    const user = await pick("No agent");
    expect(screen.getByText(/stays connected/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Unlink" }));

    await waitFor(() => expect(onChanged).toHaveBeenCalledWith(null));
    expect(puts[0]?.body).toEqual({ agent: null });
  });

  it("warns when linking moves the agent off its account on the same platform", async () => {
    const puts = mockLink();
    const other = account({ channel: "discord-old", name: "Old sales", agent: "sales:agent" });
    renderChange({
      account: account(),
      envoys: [{ agent: "sales:agent", description: null, accounts: [other] }],
    });

    await pick("sales:agent");

    expect(screen.getByText(/stops answering through Old sales/)).toBeTruthy();
    expect(puts).toEqual([]);
  });

  it("suggests main for the guardian's own account", async () => {
    mockLink();
    renderChange({ account: account({ kind: "delegate", route: null }) });
    const user = userEvent.setup();
    await user.click(screen.getByRole("combobox", { name: "Agent for Sales" }));
    expect(await screen.findByRole("option", { name: "main (suggested)" })).toBeTruthy();
  });
});
