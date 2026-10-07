import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import type { AgentEndpointSummary, AgentMessagingClient } from "../lib/rome-cloud-agents.js";
import { readAccountDirectory } from "../people/account-directory.js";
import { buildTestDeps, createTestDb, type TestDb, type TestDeps } from "../test/helpers.js";
import { seedBaseline } from "../test/seeds.js";
import { createAccountNames } from "./account-names.js";
import { agentsAccounts } from "./agents-accounts.js";
import type { Channels } from "./channel.js";

const atlas: AgentEndpointSummary = { endpoint: "atlas", kind: "dot", ready: true };

function cloud(endpoints: AgentEndpointSummary[]) {
  const client = {
    calls: 0,
    fail: false as boolean,
    async endpoints() {
      client.calls++;
      if (client.fail) throw new Error("Rome Cloud unavailable");
      return {
        endpoint: "home-rome",
        endpoints: [{ endpoint: "home-rome", kind: "rome" as const, ready: true }, ...endpoints],
      };
    },
  } satisfies Pick<AgentMessagingClient, "endpoints"> & { calls: number; fail: boolean };
  return client;
}

describe("the agents address book", () => {
  it("lists the account's other ready endpoints", async () => {
    const book = agentsAccounts({
      client: cloud([atlas, { endpoint: "pending", kind: "dot", ready: false }]),
      isConnected: () => true,
    });
    const { accounts } = await book.listAccounts({ limit: 100 });
    expect(accounts).toEqual([
      {
        id: "atlas",
        addresses: ["atlas"],
        name: null,
        identifiers: { username: "atlas", "agents:kind": "dot" },
      },
    ]);
    expect((await book.resolve("atlas"))?.id).toBe("atlas");
    expect(await book.resolve("pending")).toBeNull();
  });

  it("asks Cloud nothing until Agents is connected", async () => {
    const client = cloud([atlas]);
    const book = agentsAccounts({ client, isConnected: () => false });
    expect((await book.listAccounts({ limit: 100 })).accounts).toEqual([]);
    expect(client.calls).toBe(0);
  });

  it("shares one read across a page, and refreshes after it ages", async () => {
    let now = 0;
    const client = cloud([atlas]);
    const book = agentsAccounts({ client, isConnected: () => true, now: () => now });
    await Promise.all([book.listAccounts({ limit: 100 }), book.resolve("atlas")]);
    expect(client.calls).toBe(1);
    now = 60_000;
    await book.listAccounts({ limit: 100 });
    expect(client.calls).toBe(2);
  });

  it("lists no one when Cloud fails, and asks again next time", async () => {
    const client = cloud([atlas]);
    client.fail = true;
    const book = agentsAccounts({ client, isConnected: () => true });
    expect((await book.listAccounts({ limit: 100 })).accounts).toEqual([]);
    client.fail = false;
    expect((await book.listAccounts({ limit: 100 })).accounts).toHaveLength(1);
  });
});

describe("a dot on the People page", () => {
  let testDb: TestDb;
  let deps: TestDeps;

  beforeEach(async () => {
    testDb = createTestDb();
    await seedBaseline(testDb.db);
    deps = await buildTestDeps(testDb.db);
  });

  afterEach(() => testDb.close());

  it("is listed unlinked, then as the person the guardian links it to", async () => {
    const channels: Channels = [
      {
        name: "agents",
        accounts: agentsAccounts({ client: cloud([atlas]), isConnected: () => true }),
        send: null,
        inbound: null,
        messages: null,
      },
    ];
    const read = () =>
      readAccountDirectory({
        ...deps,
        channels,
        accountNames: createAccountNames({ channels, sentinelLogRepo: deps.sentinelLogRepo }),
      });
    const find = async () =>
      (await read()).find((a) => a.channel === "agents" && a.channelUserId === "atlas");

    expect(await find()).toMatchObject({ displayName: "atlas", state: "unlinked" });

    const personId = await deps.personMappingRepo.create({
      displayName: "Atlas",
      bondLevel: "inner-circle",
      channelMappings: [{ channel: "agents", channelUserId: "atlas" }],
    });
    expect(await find()).toMatchObject({ personId, state: "linked" });
  });
});
