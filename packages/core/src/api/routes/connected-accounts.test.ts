import { afterEach, describe, expect, it } from "@rstest/core";
import { Hono } from "hono";
import { platformOf } from "../../connections/platform.js";
import { DrizzleConnectionsRepository } from "../../connections/repository-db.js";
import { ChannelRecordsRepository } from "../../db/repositories/channel-records.js";
import { ConnectedAccountsRepository } from "../../db/repositories/connected-accounts.js";
import {
  buildAgent,
  createTestDb,
  grantReaching,
  type TestDb,
  testAccountLinkOf,
} from "../../test/helpers.js";
import type { ApiDeps } from "../deps.js";
import { connectedAccountsRoutes } from "./connected-accounts.js";

const NOW = new Date("2026-10-15T00:00:00.000Z");
const SAME_ORIGIN = { "sec-fetch-site": "same-origin", "content-type": "application/json" };

describe("connected account routes", () => {
  let testDb: TestDb | undefined;
  afterEach(() => {
    testDb?.close();
    testDb = undefined;
  });

  function setup(loaded: Record<string, string> = { "sales:agent": "sales:agent" }) {
    testDb = createTestDb();
    const db = testDb.db;
    const records = new ChannelRecordsRepository(db, testAccountLinkOf);
    const accounts = new ConnectedAccountsRepository(db);
    const ledger = new DrizzleConnectionsRepository(db);
    const held: Array<{ id: string; connectionKind: string }> = [];
    // Connect as the registry does: the connection, its channel and its
    // connected account in one go.
    const connect = (
      connection: { id: string; connectionKind: string },
      channel?: string,
      account = `acct-${connection.id}`,
    ) => {
      ledger.save(db, {
        ...connection,
        label: connection.connectionKind,
        createdAt: NOW,
        grant: grantReaching(platformOf(connection.connectionKind), account),
      });
      records.claim(db, connection, NOW, channel ? { id: channel } : {});
      accounts.add(db, connection.id);
      held.push(connection);
    };
    const agentLoader = {
      find: (name: string) => (name in loaded ? buildAgent(loaded[name]!) : undefined),
    } as unknown as ApiDeps["agentLoader"];
    // The connections Rome holds and the descriptors' kinds of link, as the
    // registry answers them.
    const connectionRegistry = {
      all: () => held,
      getDescriptor: (kind: string) => ({ link: testAccountLinkOf(kind) ?? undefined }),
    } as unknown as ApiDeps["connectionRegistry"];
    const changed: string[] = [];
    const accountListening = {
      changed: (connectionIds: Iterable<string>) => changed.push(...connectionIds),
    };
    const app = new Hono().route(
      "/",
      connectedAccountsRoutes({ db, agentLoader, accountListening, connectionRegistry }),
    );
    const link = (
      id: string,
      agent: string | null,
      headers: Record<string, string> = SAME_ORIGIN,
    ) =>
      app.request(`/accounts/${id}/agent`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ agent }),
      });
    // Disconnect as the registry does: the connection and its grant go, and
    // the connected account stays.
    const disconnect = (id: string) => ledger.remove(db, id);
    const linkAccount = (
      platform: string,
      accountId: string,
      agent: string | null,
      headers: Record<string, string> = SAME_ORIGIN,
    ) =>
      app.request(`/connected-accounts/${platform}/${encodeURIComponent(accountId)}/agent`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ agent }),
      });
    return { accounts, connect, disconnect, app, link, linkAccount, changed };
  }

  it("links an agent to a second account of a platform and keeps the first", async () => {
    const { accounts, connect, link } = setup();
    connect({ id: "c1", connectionKind: "telegram" }, "telegram");
    connect({ id: "c2", connectionKind: "telegram_user" }, "telegram_user");
    await link("c1", "sales:agent");

    const res = await link("c2", "sales:agent");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      account: { id: "c2", agent: "sales:agent", link: "delegate" },
    });
    expect(accounts.agentOf("c1")).toBe("sales:agent");
  });

  it("passes only the account a link touched on to the listening", async () => {
    const { connect, link, changed } = setup();
    connect({ id: "c1", connectionKind: "telegram" }, "telegram");
    connect({ id: "c2", connectionKind: "telegram_user" }, "telegram_user");
    await link("c1", "sales:agent");
    expect(changed).toEqual(["c1"]);

    changed.length = 0;
    await link("c2", "sales:agent");
    expect(changed).toEqual(["c2"]);

    changed.length = 0;
    await link("c2", null);
    expect(changed).toEqual(["c2"]);
  });

  it("passes nothing on when a link is refused", async () => {
    const { connect, link, changed } = setup();
    connect({ id: "c1", connectionKind: "agents" });

    expect((await link("c1", "sales:agent")).status).toBe(400);
    expect((await link("nope", "sales:agent")).status).toBe(404);
    expect(changed).toEqual([]);
  });

  it("stores the agent's canonical id", async () => {
    const { accounts, connect, link } = setup({ sales: "sales:agent" });
    connect({ id: "c1", connectionKind: "feishu" }, "feishu");

    expect((await link("c1", "sales")).status).toBe(200);
    expect(accounts.agentOf("c1")).toBe("sales:agent");
  });

  it("unlinks with null", async () => {
    const { accounts, connect, link } = setup();
    connect({ id: "c1", connectionKind: "feishu" }, "feishu");
    accounts.link("c1", "sales:agent");

    const res = await link("c1", null);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ account: { id: "c1", agent: null, link: "own_account" } });
    expect(accounts.agentOf("c1")).toBeNull();
  });

  it("refuses an agent that is not loaded, and a body without an agent", async () => {
    const { accounts, connect, app, link } = setup();
    connect({ id: "c1", connectionKind: "feishu" }, "feishu");

    expect((await link("c1", "ghost:agent")).status).toBe(400);
    const empty = await app.request("/accounts/c1/agent", {
      method: "PUT",
      headers: SAME_ORIGIN,
      body: "{}",
    });
    expect(empty.status).toBe(400);
    expect(accounts.agentOf("c1")).toBeNull();
  });

  it("links main like any agent, by its canonical id, even when no binding names it", async () => {
    const { accounts, connect, link } = setup({ assistant: "core:main" });
    connect({ id: "c1", connectionKind: "feishu" }, "feishu");
    connect({ id: "c2", connectionKind: "feishu" });

    const res = await link("c1", "main");

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ account: { id: "c1", agent: "core:main" } });
    expect((await link("c2", "assistant")).status).toBe(200);
    expect(accounts.agentOf("c2")).toBe("core:main");
  });

  it("refuses to link an account whose kind of connection takes no agent", async () => {
    const { accounts, connect, link } = setup();
    connect({ id: "c1", connectionKind: "agents" });

    expect((await link("c1", "sales:agent")).status).toBe(400);
    expect((await link("c1", null)).status).toBe(200);
    expect(accounts.agentOf("c1")).toBeNull();
  });

  it("answers 404 for a connection Rome does not hold", async () => {
    const { link } = setup();

    expect((await link("nope", "sales:agent")).status).toBe(404);
    expect((await link("nope", null)).status).toBe(404);
  });

  it("rejects a cross-site link", async () => {
    const { accounts, connect, link } = setup({
      "sales:agent": "sales:agent",
      other: "other:agent",
    });
    connect({ id: "c1", connectionKind: "feishu" }, "feishu");
    accounts.link("c1", "other:agent");

    const res = await link("c1", "sales:agent", {
      "sec-fetch-site": "cross-site",
      "content-type": "application/json",
    });

    expect(res.status).toBe(403);
    expect(accounts.agentOf("c1")).toBe("other:agent");
  });

  it("lists every connected account, a disconnected one with its agent and no connection", async () => {
    const { connect, disconnect, app, link } = setup();
    connect({ id: "c1", connectionKind: "feishu" }, "feishu");
    connect({ id: "c2", connectionKind: "telegram" }, "telegram");
    await link("c1", "sales:agent");
    disconnect("c1");

    const res = await app.request("/connected-accounts");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      accounts: [
        {
          account: { platform: "feishu", id: "acct-c1" },
          name: null,
          agent: "sales:agent",
          connection: null,
        },
        {
          account: { platform: "telegram", id: "acct-c2" },
          name: null,
          agent: null,
          connection: "c2",
        },
      ],
    });
  });

  it("links, switches and unlinks a connected account named by its account", async () => {
    const { accounts, connect, linkAccount, changed } = setup({
      "sales:agent": "sales:agent",
      support: "support:agent",
    });
    connect({ id: "c1", connectionKind: "telegram" }, "telegram");

    const linked = await linkAccount("telegram", "acct-c1", "sales:agent");
    expect(linked.status).toBe(200);
    expect(await linked.json()).toEqual({
      account: {
        account: { platform: "telegram", id: "acct-c1" },
        name: null,
        agent: "sales:agent",
        connection: "c1",
      },
    });
    expect((await linkAccount("telegram", "acct-c1", "support")).status).toBe(200);
    expect(accounts.agentOf("c1")).toBe("support:agent");
    expect((await linkAccount("telegram", "acct-c1", null)).status).toBe(200);
    expect(accounts.agentOf("c1")).toBeNull();
    expect(changed).toEqual(["c1", "c1", "c1"]);
  });

  it("unlinks a disconnected account, and refuses it a new agent until it is connected again", async () => {
    const { accounts, connect, disconnect, link, linkAccount, changed } = setup();
    connect({ id: "c1", connectionKind: "telegram" }, "telegram");
    await link("c1", "sales:agent");
    disconnect("c1");
    changed.length = 0;

    expect((await linkAccount("telegram", "acct-c1", "sales:agent")).status).toBe(409);
    const unlinked = await linkAccount("telegram", "acct-c1", null);
    expect(unlinked.status).toBe(200);
    expect(await unlinked.json()).toMatchObject({ account: { agent: null, connection: null } });
    expect(changed).toEqual([]);
    expect(accounts.all()).toMatchObject([{ accountId: "acct-c1", agent: null }]);
  });

  it("finds a disconnected account's agent when the same account is connected again", async () => {
    const { accounts, connect, disconnect, link } = setup();
    connect({ id: "c1", connectionKind: "telegram" }, "telegram");
    await link("c1", "sales:agent");
    disconnect("c1");

    connect({ id: "c2", connectionKind: "telegram" }, undefined, "acct-c1");

    expect(accounts.agentOf("c2")).toBe("sales:agent");
    expect(accounts.all()).toMatchObject([{ accountId: "acct-c1", connectionId: "c2" }]);
  });

  it("answers 404 for an account Rome has no connected account for", async () => {
    const { linkAccount } = setup();

    expect((await linkAccount("telegram", "nobody", "sales:agent")).status).toBe(404);
    expect((await linkAccount("telegram", "nobody", null)).status).toBe(404);
  });

  it("rejects a cross-site link by account", async () => {
    const { accounts, connect, linkAccount } = setup();
    connect({ id: "c1", connectionKind: "telegram" }, "telegram");

    const res = await linkAccount("telegram", "acct-c1", "sales:agent", {
      "sec-fetch-site": "cross-site",
      "content-type": "application/json",
    });

    expect(res.status).toBe(403);
    expect(accounts.agentOf("c1")).toBeNull();
  });
});
