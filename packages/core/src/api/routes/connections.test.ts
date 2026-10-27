// The registry-native connection management surface.
//
// Black-box through the routes: a real ConnectionRegistry over a drizzle-backed
// ledger, fake descriptors from the shared fixtures, requests through a Hono app
// mounting only this route module. The projection must speak registry
// vocabulary (GrantState / CapabilityStatus) and only ever surface identity
// through the descriptor's reviveProfile hook — raw profile records never cross
// to this generic surface.

import { Hono } from "hono";
import { afterEach, describe, expect, it, rs } from "@rstest/core";
import { DrizzleConnectionsRepository } from "../../connections/repository-db.js";
import { ConnectionRegistry } from "../../connections/registry.js";
import { tokenPaste } from "../../connections/schemes.js";
import {
  makeBotAll,
  makeGatedWatch,
  makePasteTalk,
  makeRenewableAct,
  updateGrant,
} from "../../connections/test-fixtures.js";
import type { Credential, ProfileRecord } from "../../connections/types.js";
import { domainOf } from "../../channels/platform.js";
import { ChannelRecordsRepository } from "../../db/repositories/channel-records.js";
import { ConnectedAccountsRepository } from "../../db/repositories/connected-accounts.js";
import { PeopleRepository } from "../../db/repositories/people.js";
import { createTestDb, identityConnectionKindOf, testAccountLinkOf } from "../../test/helpers.js";
import type { ApiDeps } from "../deps.js";
import { connectionsRoutes } from "./connections.js";

const openDbs: Array<() => void> = [];
function makeLedger(): DrizzleConnectionsRepository {
  const { db, close } = createTestDb();
  openDbs.push(close);
  return new DrizzleConnectionsRepository(db);
}

afterEach(() => {
  while (openDbs.length) openDbs.pop()?.();
});

function makeApp(registry: ConnectionRegistry, overrides: Partial<ApiDeps> = {}): Hono {
  const { db, close } = createTestDb();
  openDbs.push(close);
  return new Hono().route(
    "/",
    connectionsRoutes({
      db,
      connectionRegistry: registry,
      ...overrides,
    } as ApiDeps),
  );
}

const SAME_ORIGIN = { "sec-fetch-site": "same-origin" };

/** The pasteTalk (telegram-like) fixture plus a reviveProfile hook, so the
 *  route's display projection has a service-owned schema to go through. */
function makePasteTalkWithProfile() {
  const fixture = makePasteTalk();
  fixture.descriptor.reviveProfile = (record: ProfileRecord) => ({
    displayName: record.name as string | undefined,
    handle: record.login as string | undefined,
    email: undefined,
    avatarUrl: undefined,
  });
  return fixture;
}

describe("GET /connections", () => {
  it("lists every connection with grants, capabilities, and revived display", async () => {
    const registry = new ConnectionRegistry({ repository: makeLedger() });
    const telegram = makePasteTalkWithProfile();
    const discord = makeBotAll();
    registry.register(telegram.descriptor);
    registry.register(discord.descriptor);

    const tg = await registry.connect("fake-telegram", "Telegram");
    await registry.connect("fake-discord", "Discord");
    await registry.giveGrant(tg.connectionKind, tg.id, "bot", telegram.validCredential(), {
      name: "Rome Bot",
      login: "rome_bot",
    });

    const res = await makeApp(registry).request("/connections");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const { connections } = await res.json();

    // Stable ordering: sorted by service.
    expect(connections.map((c: { service: string }) => c.service)).toEqual([
      "fake-discord",
      "fake-telegram",
    ]);

    const [d, t] = connections;
    expect(t).toEqual({
      id: tg.id,
      connectionKind: "fake-telegram",
      service: "fake-telegram",
      label: "Telegram",
      state: "working",
      grants: { bot: "authorized" },
      display: {
        bot: { displayName: "Rome Bot", handle: "rome_bot", email: null, avatarUrl: null },
      },
      capabilities: {
        chat: { state: "unlocked" },
        talk: { state: "unlocked" },
        act: { state: "unsupported" },
        watch: { state: "unsupported" },
      },
      connect: null,
      setups: {},
      channel: null,
      platform: null,
      account: null,
      // The fake bot declares itself a kind whose accounts take an agent.
      agent: null,
      link: "own_account",
      severalAccounts: false,
    });

    // Nothing granted on discord yet: its grant unauthorized, everything
    // locked, and no display (no profile AND no reviveProfile).
    expect(d.label).toBe("Discord");
    expect(d.grants).toEqual({ bot: "unauthorized" });
    expect(d.display).toEqual({ bot: null });
    expect(d.capabilities.chat).toEqual({ state: "needs-auth", missingGrants: ["bot"] });
    expect(d.capabilities.act).toEqual({ state: "needs-auth", missingGrants: ["bot"] });
  });

  it("shows a degraded grant as broken, with every capability locked", async () => {
    const ledger = makeLedger();
    {
      const setup = new ConnectionRegistry({ repository: ledger });
      const fixture = makeBotAll();
      setup.register(fixture.descriptor);
      const conn = await setup.connect("fake-discord", "Discord");
      await setup.giveGrant(conn.connectionKind, conn.id, "bot", fixture.botCredential());
      await updateGrant(ledger, conn.id, (current) => ({
        ...current,
        state: "degraded",
        degraded: { at: new Date("2026-07-13T00:00:00Z"), reason: "token revoked upstream" },
      }));
    }
    // Fresh registry over the same ledger — the boot-shaped path to a degraded grant.
    const registry = new ConnectionRegistry({ repository: ledger });
    registry.register(makeBotAll().descriptor);
    await registry.load();

    const res = await makeApp(registry).request("/connections");
    const { connections } = await res.json();
    const [d] = connections;

    expect(d.state).toBe("broken");
    expect(d.grants).toEqual({ bot: "degraded" });
    expect(d.capabilities.chat).toEqual({ state: "needs-auth", missingGrants: ["bot"] });
    expect(d.capabilities.act).toEqual({ state: "needs-auth", missingGrants: ["bot"] });
  });

  it("surfaces needs-subscription for a gated watch with no active subscription", async () => {
    const registry = new ConnectionRegistry({ repository: makeLedger() });
    const gated = makeGatedWatch();
    registry.register(gated.descriptor);
    const conn = await registry.connect("fake-github-watch");
    await registry.giveGrant(conn.connectionKind, conn.id, "user", gated.userCredential());

    const app = makeApp(registry);
    let res = await app.request("/connections");
    let body = await res.json();
    expect(body.connections[0].capabilities.watch).toEqual({ state: "needs-subscription" });

    // The detail view carries the same needs-subscription context.
    const detail = await (await app.request(`/connections/${conn.id}`)).json();
    expect(detail.connection.capabilities.watch).toEqual({ state: "needs-subscription" });

    await registry.setWatchSubscribed(conn.id, true);
    res = await app.request("/connections");
    body = await res.json();
    expect(body.connections[0].capabilities.watch).toEqual({ state: "unlocked" });
  });

  it("lists an offerable placeholder for a registered service with no connection row", async () => {
    const registry = new ConnectionRegistry({ repository: makeLedger() });
    const telegram = makePasteTalkWithProfile();
    const discord = makeBotAll();
    registry.register(telegram.descriptor);
    registry.register(discord.descriptor);
    // Only telegram is connected; discord stays an offerable placeholder.
    const tg = await registry.connect("fake-telegram", "Telegram");

    const res = await makeApp(registry).request("/connections");
    const { connections } = await res.json();

    expect(
      connections.map((c: { service: string; id: string | null }) => [c.service, c.id]),
    ).toEqual([
      ["fake-discord", null],
      ["fake-telegram", tg.id],
    ]);

    const [placeholder] = connections;
    expect(placeholder).toEqual({
      id: null,
      connectionKind: "fake-discord",
      service: "fake-discord",
      label: "fake-discord",
      state: null,
      grants: { bot: "unauthorized" },
      display: { bot: null },
      capabilities: {
        chat: { state: "needs-auth", missingGrants: ["bot"] },
        talk: { state: "needs-auth", missingGrants: ["bot"] },
        act: { state: "needs-auth", missingGrants: ["bot"] },
        watch: { state: "needs-auth", missingGrants: ["bot"] },
      },
      connect: null,
      setups: {},
      channel: null,
      platform: null,
      account: null,
      link: null,
      severalAccounts: false,
    });
  });

  it("offers OAuth placeholders only for host-enabled providers", async () => {
    const prev = process.env.SHOW_GOOGLE_OAUTH;
    delete process.env.SHOW_GOOGLE_OAUTH;
    try {
      const registry = new ConnectionRegistry({ repository: makeLedger() });
      // Both descriptors register unconditionally (existing accounts must
      // import regardless), but only enabled providers are connect invitations.
      for (const provider of ["github", "google"]) {
        registry.register({
          connectionKind: provider,
          grant: "user",
          auth: tokenPaste({ label: "token", validate: async () => {} }),
          capabilities: {},
        });
      }

      const res = await makeApp(registry).request("/connections");
      const { connections } = await res.json();
      expect(connections.map((c: { service: string }) => c.service)).toEqual(["github"]);
      expect(connections[0].id).toBeNull();
    } finally {
      if (prev !== undefined) process.env.SHOW_GOOGLE_OAUTH = prev;
    }
  });

  it("resolves the Rome Cloud connect hint for OAuth-brokered services", async () => {
    const prev = process.env.PANTHEON_BASE_ORIGIN;
    process.env.PANTHEON_BASE_ORIGIN = "https://rome-cloud.example";
    try {
      const registry = new ConnectionRegistry({ repository: makeLedger() });
      registry.register({
        connectionKind: "github",
        grant: "user",
        auth: tokenPaste({ label: "token", validate: async () => {} }),
        capabilities: {},
      });
      await registry.connect("github", "GitHub");

      const res = await makeApp(registry).request("/connections");
      const { connections } = await res.json();
      expect(connections[0].connect).toEqual({
        url: "/api/oauth/github/start",
        available: true,
        unavailableReason: null,
      });
    } finally {
      if (prev === undefined) delete process.env.PANTHEON_BASE_ORIGIN;
      else process.env.PANTHEON_BASE_ORIGIN = prev;
    }
  });
});

describe("GET /connections/:id", () => {
  it("returns the list shape plus per-grant detail, normalized to ISO strings", async () => {
    const registry = new ConnectionRegistry({
      repository: makeLedger(),
      clock: () => new Date("2026-07-13T12:00:00Z"),
    });
    const fixture = makeBotAll();
    registry.register(fixture.descriptor);
    const conn = await registry.connect("fake-discord", "Discord");
    const expiring: Credential = {
      material: { token: "fake-discord-bot-token" },
      expiresAt: new Date("2026-08-01T00:00:00Z"),
    };
    await registry.giveGrant(conn.connectionKind, conn.id, "bot", expiring);

    const res = await makeApp(registry).request(`/connections/${conn.id}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const { connection } = await res.json();

    expect(connection.id).toBe(conn.id);
    expect(connection.grants).toEqual({ bot: "authorized" });
    expect(connection.grantDetails).toEqual({
      bot: {
        grantedAt: "2026-07-13T12:00:00.000Z",
        lastRenewedAt: null,
        degraded: null,
        tokenExpiresAt: "2026-08-01T00:00:00.000Z",
      },
    });
  });

  it("carries the degraded reason in grant detail", async () => {
    const ledger = makeLedger();
    const registry = new ConnectionRegistry({ repository: ledger });
    const fixture = makeBotAll();
    registry.register(fixture.descriptor);
    const conn = await registry.connect("fake-discord", "Discord");
    await registry.giveGrant(conn.connectionKind, conn.id, "bot", fixture.botCredential());
    await updateGrant(ledger, conn.id, (current) => ({
      ...current,
      state: "degraded",
      degraded: { at: new Date("2026-07-13T00:00:00Z"), reason: "token revoked upstream" },
    }));

    const res = await makeApp(registry).request(`/connections/${conn.id}`);
    const { connection } = await res.json();
    expect(connection.grantDetails.bot.degraded).toEqual({
      at: "2026-07-13T00:00:00.000Z",
      reason: "token revoked upstream",
    });
  });

  it("404s an unknown connection id", async () => {
    const registry = new ConnectionRegistry({ repository: makeLedger() });
    const res = await makeApp(registry).request("/connections/nope");
    expect(res.status).toBe(404);
  });
});

describe("DELETE /connections/:id/grants/:name", () => {
  it("revokes the grant, stops its capabilities and ends the connection", async () => {
    const registry = new ConnectionRegistry({ repository: makeLedger() });
    const fixture = makeBotAll();
    registry.register(fixture.descriptor);
    const conn = await registry.connect("fake-discord", "Discord");
    await registry.giveGrant(conn.connectionKind, conn.id, "bot", fixture.botCredential());

    const res = await makeApp(registry).request(`/connections/${conn.id}/grants/bot`, {
      method: "DELETE",
      headers: SAME_ORIGIN,
    });
    expect(res.status).toBe(200);
    expect((await res.json()).connection).toBeNull();
    expect(fixture.talkerFactory.instances[0].state.stopCount).toBe(1);
    expect(registry.find("fake-discord")).toHaveLength(0);
  });

  it("removes an account once it holds no grant, and releases its channel", async () => {
    const { db, close } = createTestDb();
    openDbs.push(close);
    const records = new ChannelRecordsRepository(db, testAccountLinkOf);
    const ledger = new DrizzleConnectionsRepository(db);
    const registry = new ConnectionRegistry({
      repository: ledger,
      onEvent: (tx, event) => {
        if (event.kind === "connected")
          records.claim(tx, event.connection, event.connection.createdAt);
        if (event.kind === "disconnected") records.vacate(tx, event.connection.id);
      },
    });
    const fixture = makePasteTalk();
    registry.register(fixture.descriptor);
    const conn = await registry.connect("fake-telegram");
    await registry.giveGrant(conn.connectionKind, conn.id, "bot", fixture.validCredential());

    const res = await makeApp(registry, { db }).request(`/connections/${conn.id}/grants/bot`, {
      method: "DELETE",
      headers: SAME_ORIGIN,
    });

    expect(res.status).toBe(200);
    expect((await res.json()).connection).toBeNull();
    expect(registry.find("fake-telegram")).toEqual([]);
    expect(await ledger.all()).toEqual([]);
    expect(records.idOf(conn.id)).toBeNull();
  });

  it("answers a second disconnect of the same account as done", async () => {
    const registry = new ConnectionRegistry({ repository: makeLedger() });
    const fixture = makePasteTalk();
    registry.register(fixture.descriptor);
    const conn = await registry.connect("fake-telegram");
    await registry.giveGrant(conn.connectionKind, conn.id, "bot", fixture.validCredential());
    const app = makeApp(registry);
    const disconnect = () =>
      app.request(`/connections/${conn.id}/grants/bot`, { method: "DELETE", headers: SAME_ORIGIN });

    const [first, second] = await Promise.all([disconnect(), disconnect()]);

    expect([first.status, second.status]).toEqual([200, 200]);
    expect((await second.json()).connection).toBeNull();
    expect(registry.find("fake-telegram")).toEqual([]);
  });

  it("ends a sign-in connection too, which has no Talk", async () => {
    const registry = new ConnectionRegistry({ repository: makeLedger() });
    const fixture = makeRenewableAct();
    registry.register(fixture.descriptor);
    const conn = await registry.connect("fake-github");
    await registry.giveGrant(conn.connectionKind, conn.id, "user", fixture.userCredential());

    const res = await makeApp(registry).request(`/connections/${conn.id}/grants/user`, {
      method: "DELETE",
      headers: SAME_ORIGIN,
    });

    expect(res.status).toBe(200);
    expect((await res.json()).connection).toBeNull();
    expect(registry.find("fake-github")).toHaveLength(0);
  });

  it("404s an unknown grant name and an unknown connection", async () => {
    const registry = new ConnectionRegistry({ repository: makeLedger() });
    registry.register(makeBotAll().descriptor);
    const conn = await registry.connect("fake-discord", "Discord");

    const app = makeApp(registry);
    const unknownGrant = await app.request(`/connections/${conn.id}/grants/nope`, {
      method: "DELETE",
      headers: SAME_ORIGIN,
    });
    expect(unknownGrant.status).toBe(404);

    const unknownConn = await app.request("/connections/nope/grants/user", {
      method: "DELETE",
      headers: SAME_ORIGIN,
    });
    expect(unknownConn.status).toBe(404);
  });

  it("rejects cross-site requests without revoking", async () => {
    const registry = new ConnectionRegistry({ repository: makeLedger() });
    const fixture = makeBotAll();
    registry.register(fixture.descriptor);
    const conn = await registry.connect("fake-discord", "Discord");
    await registry.giveGrant(conn.connectionKind, conn.id, "bot", fixture.botCredential());

    const res = await makeApp(registry).request(`/connections/${conn.id}/grants/bot`, {
      method: "DELETE",
      headers: { "sec-fetch-site": "cross-site" },
    });
    expect(res.status).toBe(403);
    expect(registry.get(conn.id).auth.grants().bot).toBe("authorized");
  });
});

describe("GET /connections accounts", () => {
  const telegram = makePasteTalk();

  it("reports each account's channel, an opaque id of its own", async () => {
    const { db, close } = createTestDb();
    openDbs.push(close);
    const records = new ChannelRecordsRepository(db, testAccountLinkOf);
    const registry = new ConnectionRegistry({
      repository: new DrizzleConnectionsRepository(db),
      onEvent: (tx, event) => {
        if (event.kind === "connected")
          records.claim(tx, event.connection, event.connection.createdAt);
      },
    });
    registry.register({
      ...telegram.descriptor,
      connectionKind: "telegram",
      severalAccounts: true,
    });
    const first = await registry.connect("telegram");
    await registry.giveGrant(first.connectionKind, first.id, "bot", telegram.validCredential());
    const connection = await registry.connectAnother("telegram");
    const app = makeApp(registry, { db });

    const { connections } = await (await app.request("/connections")).json();

    const channelOf = (id: string) =>
      connections.find((each: { id: string }) => each.id === id)?.channel;
    expect(channelOf(first.id)).toBe(records.idOf(first.id));
    expect(channelOf(connection.id)).toBe(records.idOf(connection.id));
    expect(channelOf(first.id)).not.toBe("telegram");
    expect(channelOf(connection.id)).not.toBe(channelOf(first.id));
  });

  it("reports a Lark app's account on the Lark platform", async () => {
    const { db, close } = createTestDb();
    openDbs.push(close);
    const records = new ChannelRecordsRepository(db, testAccountLinkOf);
    const registry = new ConnectionRegistry({
      repository: new DrizzleConnectionsRepository(db),
      onEvent: (tx, event) => {
        if (event.kind !== "connected") return;
        const record = event.connection;
        records.claim(tx, { ...record, domain: domainOf(event.profile) }, record.createdAt);
      },
    });
    registry.register({ ...telegram.descriptor, connectionKind: "feishu", severalAccounts: true });
    const lark = await registry.giveGrant("feishu", undefined, "bot", telegram.validCredential(), {
      domain: "lark",
    });

    const { connections } = await (await makeApp(registry, { db }).request("/connections")).json();

    expect(connections.find((each: { id: string }) => each.id === lark.id)).toMatchObject({
      channel: records.idOf(lark.id),
      platform: "lark",
    });
  });

  it("reports the agent linked to each account", async () => {
    const { db, close } = createTestDb();
    openDbs.push(close);
    const records = new ChannelRecordsRepository(db, testAccountLinkOf);
    const registry = new ConnectionRegistry({
      repository: new DrizzleConnectionsRepository(db),
      onEvent: (tx, event) => {
        if (event.kind === "connected")
          records.claim(tx, event.connection, event.connection.createdAt);
      },
    });
    registry.register({ ...telegram.descriptor, connectionKind: "telegram" });
    const conn = await registry.connect("telegram");
    const channel = records.idOf(conn.id) as string;
    const accounts = new ConnectedAccountsRepository(db);
    accounts.link(conn.id, "sales:agent");

    const { connections } = await (await makeApp(registry, { db }).request("/connections")).json();

    expect(connections.find((each: { id: string }) => each.id === conn.id)).toMatchObject({
      channel,
      agent: "sales:agent",
    });

    accounts.link(conn.id, null);
    const relisted = await (await makeApp(registry, { db }).request("/connections")).json();
    expect(
      relisted.connections.find((each: { id: string }) => each.id === conn.id).agent,
    ).toBeNull();
  });

  it("reports no agent for a service that takes no link", async () => {
    const { db, close } = createTestDb();
    openDbs.push(close);
    const records = new ChannelRecordsRepository(db, testAccountLinkOf);
    const registry = new ConnectionRegistry({
      repository: new DrizzleConnectionsRepository(db),
      onEvent: (tx, event) => {
        if (event.kind === "connected")
          records.claim(tx, event.connection, event.connection.createdAt);
      },
    });
    const { link: _takesNone, ...descriptor } = telegram.descriptor;
    registry.register({ ...descriptor, connectionKind: "whatsapp" });
    const conn = await registry.connect("whatsapp");

    const { connections } = await (await makeApp(registry, { db }).request("/connections")).json();

    const listed = connections.find((each: { id: string }) => each.id === conn.id);
    expect(listed.channel).toBe("whatsapp");
    expect("agent" in listed).toBe(false);
    expect(listed.link).toBeNull();
  });
});

describe("GET /connections by account", () => {
  const telegram = makePasteTalk();

  async function setup() {
    const { db, close } = createTestDb();
    openDbs.push(close);
    const registry = new ConnectionRegistry({ repository: new DrizzleConnectionsRepository(db) });
    registry.register({
      ...telegram.descriptor,
      connectionKind: "telegram",
      severalAccounts: true,
      accountIdOf: (profile) => String(profile.id),
    });
    const { link: _takesNone, ...descriptor } = telegram.descriptor;
    registry.register({ ...descriptor, connectionKind: "whatsapp" });
    const first = await registry.giveGrant(
      "telegram",
      undefined,
      "bot",
      telegram.validCredential(),
      {
        id: 41,
      },
    );
    const second = await registry.giveGrant(
      "telegram",
      undefined,
      "bot",
      telegram.validCredential(),
      { id: 42 },
      { another: true },
    );
    const list = async (query = "") => {
      const res = await makeApp(registry, { db }).request(`/connections${query}`);
      return { status: res.status, body: await res.json() };
    };
    return { first, second, list };
  }

  it("reports the account each connection's grant reaches", async () => {
    const { first, list } = await setup();

    const { body } = await list();

    expect(body.connections.find((each: { id: string }) => each.id === first.id).account).toEqual({
      platform: "telegram",
      id: "41",
    });
    expect(
      body.connections.find(
        (each: { connectionKind: string }) => each.connectionKind === "whatsapp",
      ).account,
    ).toBeNull();
  });

  it("finds the connection that reaches an account, and lists no placeholder", async () => {
    const { first, second, list } = await setup();

    const found = await list("?platform=telegram&accountId=42");
    expect(found.body.connections.map((each: { id: string }) => each.id)).toEqual([second.id]);

    const onPlatform = await list("?platform=telegram");
    expect(onPlatform.body.connections.map((each: { id: string }) => each.id).sort()).toEqual(
      [first.id, second.id].sort(),
    );

    expect((await list("?platform=lark&accountId=42")).body.connections).toEqual([]);
  });

  it("refuses an account id without its platform", async () => {
    const { list } = await setup();

    expect((await list("?accountId=42")).status).toBe(400);
  });
});

describe("DELETE /connections/:id", () => {
  it("removes the connection from the list and the ledger", async () => {
    const ledger = makeLedger();
    const registry = new ConnectionRegistry({ repository: ledger });
    const fixture = makePasteTalkWithProfile();
    registry.register(fixture.descriptor);
    const conn = await registry.connect("fake-telegram", "Telegram");
    await registry.giveGrant(conn.connectionKind, conn.id, "bot", fixture.validCredential());

    const app = makeApp(registry);
    const res = await app.request(`/connections/${conn.id}`, {
      method: "DELETE",
      headers: SAME_ORIGIN,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    // The row is gone from the ledger; the service remains offerable, so the
    // list now carries a placeholder instead of the connection.
    const list = await (await app.request("/connections")).json();
    expect(list.connections).toHaveLength(1);
    expect(list.connections[0].id).toBeNull();
    expect(list.connections[0].service).toBe("fake-telegram");
    expect(await ledger.all()).toEqual([]);
    // The live talk epoch was torn down with the connection.
    expect(fixture.talkerFactory.instances[0].state.stopCount).toBe(1);
  });

  it("404s an unknown connection and rejects cross-site requests", async () => {
    const registry = new ConnectionRegistry({ repository: makeLedger() });
    registry.register(makePasteTalk().descriptor);
    const conn = await registry.connect("fake-telegram");

    const app = makeApp(registry);
    const unknown = await app.request("/connections/nope", {
      method: "DELETE",
      headers: SAME_ORIGIN,
    });
    expect(unknown.status).toBe(404);

    const crossSite = await app.request(`/connections/${conn.id}`, {
      method: "DELETE",
      headers: { "sec-fetch-site": "cross-site" },
    });
    expect(crossSite.status).toBe(403);
    expect(registry.all()).toHaveLength(1);
  });
});

describe("guardian links across a disconnect", () => {
  // A link is a fact about who is who, not about Rome's access
  // (docs/domains/people.md#link), so connecting again finds the guardian known.
  it.each([
    "connection",
    "grant",
  ])("keeps the guardian link when the %s teardown removes Rome's access", async (teardown) => {
    const { db, close } = createTestDb();
    openDbs.push(close);
    const registry = new ConnectionRegistry({ repository: new DrizzleConnectionsRepository(db) });
    const fixture = makeBotAll();
    fixture.descriptor.connectionKind = "discord";
    registry.register(fixture.descriptor);
    const conn = await registry.connect("discord");
    await registry.giveGrant(conn.connectionKind, conn.id, "bot", fixture.botCredential());
    const peopleRepo = new PeopleRepository(db, identityConnectionKindOf);
    await peopleRepo.create({
      displayName: "Guardian",
      bondLevel: "guardian",
      links: [{ channel: "discord", channelUserId: "linked" }],
    });
    const suffix = teardown === "connection" ? "" : "/grants/bot";

    const response = await makeApp(registry, { db }).request(`/connections/${conn.id}${suffix}`, {
      method: "DELETE",
      headers: SAME_ORIGIN,
    });

    expect(response.status).toBe(200);
    expect(
      await peopleRepo.byAccount({ channel: "discord", channelUserId: "linked" }),
    ).not.toBeNull();
  });
});
