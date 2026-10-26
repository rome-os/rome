import { afterEach, describe, expect, it } from "@rstest/core";
import { Hono } from "hono";
import { DrizzleGrantLedger } from "../../connections/ledger-db.js";
import { ChannelRecordsRepository } from "../../db/repositories/channel-records.js";
import { ConnectedAccountsRepository } from "../../db/repositories/connected-accounts.js";
import { createTestDb, type TestDb } from "../../test/helpers.js";
import type { ApiDeps } from "../deps.js";
import { channelAccountsRoutes } from "./channel-accounts.js";

const NOW = new Date("2026-10-15T00:00:00.000Z");
const SAME_ORIGIN = { "sec-fetch-site": "same-origin", "content-type": "application/json" };

describe("channel account routes", () => {
  let testDb: TestDb | undefined;
  afterEach(() => {
    testDb?.close();
    testDb = undefined;
  });

  function setup(loaded: Record<string, string> = { "sales:agent": "sales:agent" }) {
    testDb = createTestDb();
    const db = testDb.db;
    const records = new ChannelRecordsRepository(db);
    const accounts = new ConnectedAccountsRepository(db);
    const ledger = new DrizzleGrantLedger(db);
    // Connect as the registry does: the connection, its channel and its
    // connected account in one go.
    const claim = (
      connection: { id: string; connectionKind: string },
      now: Date,
      opts?: { id?: string },
    ) => {
      ledger.writeConnection(db, {
        ...connection,
        label: connection.connectionKind,
        createdAt: now,
      });
      records.claim(db, connection, now, opts);
      accounts.add(db, connection.id);
    };
    const connectionOf = (channel: string) => records.byId(channel)!.connectionId!;
    const agentOf = (channel: string) => accounts.agentOf(connectionOf(channel));
    const store = (channel: string, agent: string | null) =>
      accounts.link(connectionOf(channel), agent);
    const agentLoader = {
      has: (name: string) => name in loaded,
      getCanonicalName: (name: string) => loaded[name]!,
    } as unknown as ApiDeps["agentLoader"];
    const changed: Array<string | null> = [];
    const accountListening = {
      changed: (channels: Iterable<string | null>) => changed.push(...channels),
    };
    const app = new Hono().route(
      "/",
      channelAccountsRoutes({ db: testDb.db, agentLoader, accountListening }),
    );
    const link = (
      id: string,
      agent: string | null,
      headers: Record<string, string> = SAME_ORIGIN,
    ) =>
      app.request(`/channels/accounts/${id}/agent`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ agent }),
      });
    return { records, claim, agentOf, store, app, link, changed, db };
  }

  it("lists each account with its agent", async () => {
    const { claim, store, app } = setup();
    claim({ id: "c1", connectionKind: "feishu" }, NOW, { id: "feishu" });
    store("feishu", "sales:agent");

    const res = await app.request("/channels/accounts");

    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({
      accounts: [
        {
          id: "feishu",
          connectionKind: "feishu",
          service: "feishu",
          platform: "feishu",
          connectionId: "c1",
          agent: "sales:agent",
        },
      ],
    });
  });

  it("links an agent to a second account of a platform and keeps the first", async () => {
    const { claim, agentOf, link } = setup();
    claim({ id: "c1", connectionKind: "telegram" }, NOW, { id: "telegram" });
    claim({ id: "c2", connectionKind: "telegram_user" }, NOW, { id: "telegram_user" });
    await link("telegram", "sales:agent");

    const res = await link("telegram_user", "sales:agent");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      account: {
        id: "telegram_user",
        connectionKind: "telegram_user",
        service: "telegram_user",
        platform: "telegram",
        connectionId: "c2",
        agent: "sales:agent",
      },
    });
    expect(agentOf("telegram")).toBe("sales:agent");
  });

  it("passes only the account a link touched on to the listening", async () => {
    const { claim, agentOf, link, changed } = setup();
    claim({ id: "c1", connectionKind: "telegram" }, NOW, { id: "telegram" });
    claim({ id: "c2", connectionKind: "telegram_user" }, NOW, { id: "telegram_user" });
    await link("telegram", "sales:agent");
    expect(changed).toEqual(["telegram"]);

    changed.length = 0;
    await link("telegram_user", "sales:agent");
    expect(changed).toEqual(["telegram_user"]);
    expect(agentOf("telegram")).toBe("sales:agent");

    changed.length = 0;
    await link("telegram_user", null);
    expect(changed).toEqual(["telegram_user"]);
  });

  it("passes nothing on when a link is refused", async () => {
    const { claim, link, changed } = setup();
    claim({ id: "c1", connectionKind: "agents" }, NOW);

    expect((await link("agents", "sales:agent")).status).toBe(400);
    expect((await link("nope", "sales:agent")).status).toBe(404);
    expect(changed).toEqual([]);
  });

  it("stores the agent's canonical id", async () => {
    const { claim, agentOf, link } = setup({ sales: "sales:agent" });
    claim({ id: "c1", connectionKind: "feishu" }, NOW, { id: "feishu" });

    expect((await link("feishu", "sales")).status).toBe(200);
    expect(agentOf("feishu")).toBe("sales:agent");
  });

  it("unlinks with null", async () => {
    const { claim, agentOf, store, link } = setup();
    claim({ id: "c1", connectionKind: "feishu" }, NOW, { id: "feishu" });
    store("feishu", "sales:agent");

    const res = await link("feishu", null);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ account: { agent: null } });
    expect(agentOf("feishu")).toBeNull();
  });

  it("refuses an agent that is not loaded, and a body without an agent", async () => {
    const { claim, agentOf, app, link } = setup();
    claim({ id: "c1", connectionKind: "feishu" }, NOW, { id: "feishu" });

    expect((await link("feishu", "ghost:agent")).status).toBe(400);
    const empty = await app.request("/channels/accounts/feishu/agent", {
      method: "PUT",
      headers: SAME_ORIGIN,
      body: "{}",
    });
    expect(empty.status).toBe(400);
    expect(agentOf("feishu")).toBeNull();
  });

  it("links main like any agent, by its canonical id", async () => {
    const { claim, agentOf, store, link } = setup({ main: "core:main", assistant: "core:main" });
    claim({ id: "c1", connectionKind: "feishu" }, NOW, { id: "feishu" });
    store("feishu", null);

    const res = await link("feishu", "main");

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      account: { id: "feishu", agent: "core:main" },
    });
    store("feishu", null);
    expect((await link("feishu", "assistant")).status).toBe(200);
    expect(agentOf("feishu")).toBe("core:main");
  });

  it("links main even when no binding names it", async () => {
    const { records, claim, agentOf, link } = setup({});
    claim({ id: "c1", connectionKind: "telegram" }, NOW, { id: "telegram" });
    claim({ id: "c2", connectionKind: "telegram" }, NOW);
    const second = records.byConnection("c2")!.id;

    expect((await link(second, "main")).status).toBe(200);
    expect(agentOf(second)).toBe("core:main");
  });

  it("keeps main on every account of one platform it is linked to", async () => {
    const { claim, agentOf, store, link } = setup({ main: "core:main" });
    claim({ id: "c1", connectionKind: "telegram" }, NOW, { id: "telegram" });
    claim({ id: "c2", connectionKind: "telegram_user" }, NOW, { id: "telegram_user" });
    store("telegram", "main");

    expect((await link("telegram_user", "main")).status).toBe(200);
    expect(agentOf("telegram")).toBe("core:main");
    expect(agentOf("telegram_user")).toBe("core:main");
  });

  it("refuses to link an account of a service that is not linkable", async () => {
    const { claim, agentOf, link } = setup();
    claim({ id: "c1", connectionKind: "agents" }, NOW);

    expect((await link("agents", "sales:agent")).status).toBe(400);
    expect((await link("agents", null)).status).toBe(200);
    expect(agentOf("agents")).toBeNull();
  });

  it("answers 404 for a missing account and 409 for an unbacked one", async () => {
    const { records, claim, link, db } = setup();
    claim({ id: "c1", connectionKind: "feishu" }, NOW, { id: "feishu" });
    records.vacate(db, "c1");

    expect((await link("nope", "sales:agent")).status).toBe(404);
    expect((await link("feishu", "sales:agent")).status).toBe(409);
  });

  it("rejects a cross-site link", async () => {
    const { claim, agentOf, store, link } = setup({
      "sales:agent": "sales:agent",
      other: "other:agent",
    });
    claim({ id: "c1", connectionKind: "feishu" }, NOW, { id: "feishu" });
    store("feishu", "other:agent");

    const res = await link("feishu", "sales:agent", {
      "sec-fetch-site": "cross-site",
      "content-type": "application/json",
    });

    expect(res.status).toBe(403);
    expect(agentOf("feishu")).toBe("other:agent");
  });
});
