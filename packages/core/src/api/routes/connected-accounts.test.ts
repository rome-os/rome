import { afterEach, describe, expect, it } from "@rstest/core";
import { Hono } from "hono";
import { DrizzleGrantLedger } from "../../connections/ledger-db.js";
import { ChannelRecordsRepository } from "../../db/repositories/channel-records.js";
import { ConnectedAccountsRepository } from "../../db/repositories/connected-accounts.js";
import { createTestDb, type TestDb, testAccountLinkOf } from "../../test/helpers.js";
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
    const ledger = new DrizzleGrantLedger(db);
    const held: Array<{ id: string; connectionKind: string }> = [];
    // Connect as the registry does: the connection, its channel and its
    // connected account in one go.
    const connect = (connection: { id: string; connectionKind: string }, channel?: string) => {
      ledger.writeConnection(db, {
        ...connection,
        label: connection.connectionKind,
        createdAt: NOW,
      });
      records.claim(db, connection, NOW, channel ? { id: channel } : {});
      accounts.add(db, connection.id);
      held.push(connection);
    };
    const agentLoader = {
      has: (name: string) => name in loaded,
      getCanonicalName: (name: string) => loaded[name]!,
    } as unknown as ApiDeps["agentLoader"];
    // The connections Rome holds and the descriptors' kinds of link, as the
    // registry answers them.
    const connectionRegistry = {
      all: () => held,
      getDescriptor: (kind: string) => ({ link: testAccountLinkOf(kind) ?? undefined }),
    } as unknown as ApiDeps["connectionRegistry"];
    const changed: Array<string | null> = [];
    const accountListening = {
      changed: (channels: Iterable<string | null>) => changed.push(...channels),
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
    return { accounts, connect, app, link, changed };
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

  it("passes the channel of only the account a link touched on to the listening", async () => {
    const { connect, link, changed } = setup();
    connect({ id: "c1", connectionKind: "telegram" }, "telegram");
    connect({ id: "c2", connectionKind: "telegram_user" }, "telegram_user");
    await link("c1", "sales:agent");
    expect(changed).toEqual(["telegram"]);

    changed.length = 0;
    await link("c2", "sales:agent");
    expect(changed).toEqual(["telegram_user"]);

    changed.length = 0;
    await link("c2", null);
    expect(changed).toEqual(["telegram_user"]);
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
});
