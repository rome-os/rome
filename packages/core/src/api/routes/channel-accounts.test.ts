import { afterEach, describe, expect, it } from "@rstest/core";
import { Hono } from "hono";
import { ChannelRecordsRepository } from "../../db/repositories/channel-records.js";
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
    const records = new ChannelRecordsRepository(testDb.db);
    const agentLoader = {
      has: (name: string) => name in loaded,
      getCanonicalName: (name: string) => loaded[name]!,
    } as unknown as ApiDeps["agentLoader"];
    const app = new Hono().route("/", channelAccountsRoutes({ db: testDb.db, agentLoader }));
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
    return { records, app, link, db: testDb.db };
  }

  it("lists each account with its linked agent", async () => {
    const { records, app, db } = setup();
    records.claim(db, { id: "c1", service: "feishu" }, NOW);
    records.link("feishu", "sales:agent");

    const res = await app.request("/channels/accounts");

    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({
      accounts: [
        {
          id: "feishu",
          service: "feishu",
          platform: "feishu",
          connectionId: "c1",
          agent: "sales:agent",
        },
      ],
    });
  });

  it("links an agent and reports the account it moved from", async () => {
    const { records, link, db } = setup();
    records.claim(db, { id: "c1", service: "telegram" }, NOW);
    records.claim(db, { id: "c2", service: "telegram_user" }, NOW);
    await link("telegram", "sales:agent");

    const res = await link("telegram_user", "sales:agent");

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      account: { id: "telegram_user", agent: "sales:agent" },
      unlinkedFrom: "telegram",
    });
    expect(records.byId("telegram")?.agent).toBeNull();
  });

  it("stores the agent's canonical id", async () => {
    const { records, link, db } = setup({ sales: "sales:agent" });
    records.claim(db, { id: "c1", service: "feishu" }, NOW);

    expect((await link("feishu", "sales")).status).toBe(200);
    expect(records.byId("feishu")?.agent).toBe("sales:agent");
  });

  it("unlinks with null", async () => {
    const { records, link, db } = setup();
    records.claim(db, { id: "c1", service: "feishu" }, NOW);
    records.link("feishu", "sales:agent");

    const res = await link("feishu", null);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ account: { agent: null }, unlinkedFrom: null });
    expect(records.byId("feishu")?.agent).toBeNull();
  });

  it("refuses an agent that is not loaded, and a body without an agent", async () => {
    const { records, link, app, db } = setup();
    records.claim(db, { id: "c1", service: "feishu" }, NOW);

    expect((await link("feishu", "ghost:agent")).status).toBe(400);
    const empty = await app.request("/channels/accounts/feishu/agent", {
      method: "PUT",
      headers: SAME_ORIGIN,
      body: "{}",
    });
    expect(empty.status).toBe(400);
    expect(records.byId("feishu")?.agent).toBe("core:main");
  });

  it("links main like any agent, by its canonical id", async () => {
    const { records, link, db } = setup({ main: "core:main", assistant: "core:main" });
    records.claim(db, { id: "c1", service: "feishu" }, NOW);
    records.link("feishu", null);

    const res = await link("feishu", "main");

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      account: { id: "feishu", agent: "core:main" },
      unlinkedFrom: null,
    });
    records.link("feishu", null);
    expect((await link("feishu", "assistant")).status).toBe(200);
    expect(records.byId("feishu")?.agent).toBe("core:main");
  });

  it("links main even when no binding names it", async () => {
    const { records, link, db } = setup({});
    records.claim(db, { id: "c1", service: "telegram" }, NOW);
    records.claim(db, { id: "c2", service: "telegram" }, NOW);
    const second = records.byConnection("c2")!.id;

    expect((await link(second, "main")).status).toBe(200);
    expect(records.byId(second)?.agent).toBe("core:main");
  });

  it("keeps main on every account of one platform it is linked to", async () => {
    const { records, link, db } = setup({ main: "core:main" });
    records.claim(db, { id: "c1", service: "telegram" }, NOW);
    records.claim(db, { id: "c2", service: "telegram_user" }, NOW);
    records.link("telegram_user", null);

    const res = await link("telegram_user", "main");

    expect(await res.json()).toMatchObject({ unlinkedFrom: null });
    expect(records.byId("telegram")?.agent).toBe("core:main");
    expect(records.byId("telegram_user")?.agent).toBe("core:main");
  });

  it("refuses to link an account of a service that is not linkable", async () => {
    const { records, link, db } = setup();
    records.claim(db, { id: "c1", service: "agents" }, NOW);

    expect((await link("agents", "sales:agent")).status).toBe(400);
    expect((await link("agents", null)).status).toBe(200);
    expect(records.byId("agents")?.agent).toBeNull();
  });

  it("answers 404 for a missing account and 409 for an unbacked one", async () => {
    const { records, link, db } = setup();
    records.claim(db, { id: "c1", service: "feishu" }, NOW);
    records.vacate(db, "c1");

    expect((await link("nope", "sales:agent")).status).toBe(404);
    expect((await link("feishu", "sales:agent")).status).toBe(409);
  });

  it("rejects a cross-site link", async () => {
    const { records, link, db } = setup();
    records.claim(db, { id: "c1", service: "feishu" }, NOW);

    const res = await link("feishu", "sales:agent", {
      "sec-fetch-site": "cross-site",
      "content-type": "application/json",
    });

    expect(res.status).toBe(403);
    expect(records.byId("feishu")?.agent).toBe("core:main");
  });
});
