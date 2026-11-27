import { describe, expect, it } from "@rstest/core";
import type {
  ExternalAgent,
  AgentMessagingClient,
} from "../../connections/integrations/rome-cloud-agents.js";
import { agentsAccounts, externalAgents } from "./agents-accounts.js";

const HOME = { agentId: "0d9e8f7a-6b5c-4d3e-8f1a-2b3c4d5e6f70", name: "home-rome" };
const ATLAS = "6f1c2d9e-0a4b-4c1d-9e2f-3a4b5c6d7e8f";
const FRIEND_ATLAS = "7a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d";

const atlas: ExternalAgent = {
  agentId: ATLAS,
  name: "atlas",
  kind: "dot",
  account: "ouou",
  sameAccount: true,
};
const friendAtlas: ExternalAgent = {
  agentId: FRIEND_ATLAS,
  name: "atlas",
  kind: "dot",
  account: "friend",
  sameAccount: false,
};

function cloud(agents: ExternalAgent[]) {
  const client = {
    calls: 0,
    fail: false as boolean,
    async agents() {
      client.calls++;
      if (client.fail) throw new Error("Rome Cloud unavailable");
      return {
        self: HOME,
        agents: [{ ...HOME, kind: "rome" as const, account: "ouou", sameAccount: true }, ...agents],
      };
    },
  } satisfies Pick<AgentMessagingClient, "agents"> & { calls: number; fail: boolean };
  return client;
}

describe("the agents address book", () => {
  it("lists the account's other agents by agent id, leaving out this Rome", async () => {
    const book = agentsAccounts(
      externalAgents({ client: cloud([atlas]), isConnected: () => true }),
    );
    const { accounts } = await book.listAccounts({ limit: 100 });
    expect(accounts).toEqual([
      {
        id: ATLAS,
        addresses: [ATLAS],
        name: "atlas (dot)",
        identifiers: { "agents:id": ATLAS, "agents:kind": "dot", "agents:account": "ouou" },
      },
    ]);
    expect((await book.resolve(ATLAS))?.name).toBe("atlas (dot)");
  });

  it("tells apart two accounts' agents that share a name", async () => {
    const book = agentsAccounts(
      externalAgents({ client: cloud([atlas, friendAtlas]), isConnected: () => true }),
    );
    const { accounts } = await book.listAccounts({ limit: 100 });
    expect(accounts.map((account) => [account.id, account.name])).toEqual([
      [FRIEND_ATLAS, "atlas (@friend's dot)"],
      [ATLAS, "atlas (dot)"],
    ]);
  });

  it("orders same-named agents of one account by id, so paging is stable", async () => {
    const second = { ...atlas, agentId: "00000000-0000-4000-8000-000000000001" };
    const book = agentsAccounts(
      externalAgents({ client: cloud([atlas, second]), isConnected: () => true }),
    );
    const first = await book.listAccounts({ limit: 1 });
    const rest = await book.listAccounts({ limit: 1, cursor: first.nextCursor });
    expect([...first.accounts, ...rest.accounts].map((account) => account.id)).toEqual([
      second.agentId,
      ATLAS,
    ]);
  });

  it("lists no agents, rather than failing the page, when it cannot read Cloud's listing", async () => {
    const client = cloud([atlas]);
    client.agents = async () => ({ self: HOME, agents: null as never });
    const book = agentsAccounts(externalAgents({ client, isConnected: () => true }));
    expect((await book.listAccounts({ limit: 100 })).accounts).toEqual([]);
  });

  it("finds an agent by searching for its id", async () => {
    const book = agentsAccounts(
      externalAgents({ client: cloud([atlas, friendAtlas]), isConnected: () => true }),
    );
    const { accounts } = await book.listAccounts({ query: ATLAS, limit: 100 });
    expect(accounts.map((account) => account.id)).toEqual([ATLAS]);
  });

  it("resolves an agent it does not list, such as one answering Rome, but nothing else", async () => {
    const book = agentsAccounts(
      externalAgents({ client: cloud([atlas]), isConnected: () => true }),
    );
    expect(await book.resolve(FRIEND_ATLAS)).toEqual({
      id: FRIEND_ATLAS,
      addresses: [FRIEND_ATLAS],
      name: null,
      identifiers: { "agents:id": FRIEND_ATLAS },
    });
    expect(await book.resolve("atlas")).toBeNull();
    expect(await book.resolve("@friend/atlas")).toBeNull();
    expect(await book.resolve(ATLAS.toUpperCase())).toBeNull();
  });

  it("asks Cloud nothing until Agents is connected", async () => {
    const client = cloud([atlas]);
    const book = agentsAccounts(externalAgents({ client, isConnected: () => false }));
    expect((await book.listAccounts({ limit: 100 })).accounts).toEqual([]);
    expect(client.calls).toBe(0);
  });

  it("shares one read across a page, and refreshes after it ages", async () => {
    let now = 0;
    const client = cloud([atlas]);
    const book = agentsAccounts(
      externalAgents({ client, isConnected: () => true, now: () => now }),
    );
    await Promise.all([book.listAccounts({ limit: 100 }), book.resolve(ATLAS)]);
    expect(client.calls).toBe(1);
    now = 60_000;
    await book.listAccounts({ limit: 100 });
    expect(client.calls).toBe(2);
  });

  it("lists no one when Cloud fails, and asks again only after the read ages", async () => {
    let now = 0;
    const client = cloud([atlas]);
    client.fail = true;
    const book = agentsAccounts(
      externalAgents({ client, isConnected: () => true, now: () => now }),
    );
    expect((await book.listAccounts({ limit: 100 })).accounts).toEqual([]);
    client.fail = false;
    expect((await book.listAccounts({ limit: 100 })).accounts).toEqual([]);
    expect(client.calls).toBe(1);
    now = 60_000;
    expect((await book.listAccounts({ limit: 100 })).accounts).toHaveLength(1);
  });
});
