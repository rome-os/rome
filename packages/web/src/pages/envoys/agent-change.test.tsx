// @rstest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, rs } from "@rstest/core";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MAIN_AGENT_ID } from "@rome/api-types/account-agents";
import i18n from "@/i18n";
import { AgentChange } from "./agent-change";
import type { EnvoyAccount } from "./envoys-model";

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
    return new Response(JSON.stringify({ account: {} }), { status: 200 });
  });
  return puts;
}

function renderChange(props: {
  account: EnvoyAccount;
  onChanged?: (agent: string | null) => void;
}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <AgentChange
        account={props.account}
        agents={[MAIN_AGENT_ID, "sales:agent"]}
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
  it("keeps the account's own agent selectable when core no longer loads it", async () => {
    renderChange({ account: account({ agent: "gone:agent" }) });
    const user = userEvent.setup();
    await user.click(screen.getByRole("combobox", { name: "Agent for Sales" }));
    expect(await screen.findByRole("option", { name: "gone:agent" })).toBeTruthy();
  });

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

  it("suggests main for the guardian's own account", async () => {
    mockLink();
    renderChange({ account: account({ kind: "delegate", route: null }) });
    const user = userEvent.setup();
    await user.click(screen.getByRole("combobox", { name: "Agent for Sales" }));
    expect(await screen.findByRole("option", { name: "main (suggested)" })).toBeTruthy();
  });

  it("asks before linking an agent to the guardian's own account", async () => {
    const puts = mockLink();
    renderChange({
      account: account({
        service: "telegram_user",
        platform: "telegram",
        kind: "delegate",
        route: null,
      }),
    });

    const user = await pick("main (suggested)");
    expect(puts).toEqual([]);
    expect(screen.getByText(/your personal chats on your behalf/)).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Link" }));
    await waitFor(() =>
      expect(puts).toEqual([
        { url: "/api/channels/accounts/discord/agent", body: { agent: MAIN_AGENT_ID } },
      ]),
    );
  });
});
