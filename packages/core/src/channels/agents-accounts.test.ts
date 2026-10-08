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
        address: "@ouou/home-rome",
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

  it("lists a linked account's endpoints by their full address, even one sharing this Rome's name", async () => {
    const book = agentsAccounts({
      client: cloud([
        atlas,
        {
          endpoint: "@friend/atlas",
          kind: "dot",
          ready: true,
          sameAccount: false,
          address: "@friend/atlas",
        },
        {
          endpoint: "@friend/home-rome",
          kind: "rome",
          ready: true,
          sameAccount: false,
          address: "@friend/home-rome",
        },
      ]),
      isConnected: () => true,
    });
    const { accounts } = await book.listAccounts({ limit: 100 });
    expect(accounts.map((account) => account.id)).toEqual([
      "@friend/atlas",
      "@friend/home-rome",
      "atlas",
    ]);
    expect(accounts[0]).toEqual({
      id: "@friend/atlas",
      addresses: ["@friend/atlas"],
      name: null,
      identifiers: { username: "@friend/atlas", "agents:kind": "dot", "agents:account": "friend" },
    });
  });

  it("resolves another account's agent it does not list, such as one answering Rome", async () => {
    const book = agentsAccounts({ client: cloud([atlas]), isConnected: () => true });
    expect(await book.resolve("@friend/atlas")).toEqual({
      id: "@friend/atlas",
      addresses: ["@friend/atlas"],
      name: null,
      identifiers: { username: "@friend/atlas", "agents:account": "friend" },
    });
    expect(await book.resolve("muse")).toBeNull();
    expect(await book.resolve("@friend")).toBeNull();
  });

  it("resolves no other account's agent until Cloud has named this account's handle", async () => {
    const client = cloud([atlas]);
    client.fail = true;
    const book = agentsAccounts({ client, isConnected: () => true });
    expect(await book.resolve("@ouou/atlas")).toBeNull();
    expect(await book.resolve("@friend/atlas")).toBeNull();
  });

  it("folds an own agent's full address onto its bare name, and never makes it external", async () => {
    const book = agentsAccounts({
      client: {
        endpoints: async () => ({
          endpoint: "home-rome",
          address: "@ouou/home-rome",
          endpoints: [{ ...atlas, address: "@ouou/atlas", sameAccount: true }],
        }),
      },
      isConnected: () => true,
    });
    const { accounts } = await book.listAccounts({ limit: 100 });
    expect(accounts).toEqual([
      {
        id: "atlas",
        addresses: ["atlas", "@ouou/atlas"],
        name: null,
        identifiers: { username: "atlas", "agents:kind": "dot" },
      },
    ]);
    expect((await book.resolve("@ouou/atlas"))?.id).toBe("atlas");
    expect(await book.resolve("@ouou/removed")).toBeNull();
    expect((await book.resolve("@friend/atlas"))?.id).toBe("@friend/atlas");
    expect(await book.resolve("@@friend/atlas")).toBeNull();
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

  it("lists no one when Cloud fails, and asks again only after the read ages", async () => {
    let now = 0;
    const client = cloud([atlas]);
    client.fail = true;
    const book = agentsAccounts({ client, isConnected: () => true, now: () => now });
    expect((await book.listAccounts({ limit: 100 })).accounts).toEqual([]);
    client.fail = false;
    expect((await book.listAccounts({ limit: 100 })).accounts).toEqual([]);
    expect(client.calls).toBe(1);
    now = 60_000;
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
        directory: null,
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

describe("another account's agent on the People page", () => {
  let testDb: TestDb;
  let deps: TestDeps;

  beforeEach(async () => {
    testDb = createTestDb();
    await seedBaseline(testDb.db);
    deps = await buildTestDeps(testDb.db);
  });

  afterEach(() => testDb.close());

  it("is listed unlinked under its full address", async () => {
    const channels: Channels = [
      {
        name: "agents",
        accounts: agentsAccounts({
          client: cloud([
            {
              endpoint: "atlas",
              kind: "dot",
              ready: true,
              sameAccount: false,
              address: "@friend/atlas",
            },
          ]),
          isConnected: () => true,
        }),
        send: null,
        inbound: null,
        messages: null,
        directory: null,
      },
    ];
    const accounts = await readAccountDirectory({
      ...deps,
      channels,
      accountNames: createAccountNames({ channels, sentinelLogRepo: deps.sentinelLogRepo }),
    });
    expect(accounts.find((a) => a.channel === "agents")).toMatchObject({
      channelUserId: "@friend/atlas",
      displayName: "@friend/atlas",
      state: "unlinked",
      personId: null,
    });
  });
});
