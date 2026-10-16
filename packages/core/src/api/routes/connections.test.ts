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
import { DrizzleGrantLedger } from "../../connections/ledger-db.js";
import { ConnectionRegistry } from "../../connections/registry.js";
import { tokenPaste } from "../../connections/schemes.js";
import {
  makeGatedWatch,
  makePasteTalk,
  makeTwoGrant,
  makeZeroGrantTalk,
} from "../../connections/test-fixtures.js";
import type { Credential, ProfileRecord } from "../../connections/types.js";
import { ApprovalsRepository } from "../../db/repositories/approvals.js";
import { ChannelRecordsRepository } from "../../db/repositories/channel-records.js";
import { PersonMappingRepository } from "../../db/repositories/person-mapping.js";
import { createTestDb, identityServiceOf } from "../../test/helpers.js";
import type { ApiDeps } from "../deps.js";
import { connectionsRoutes } from "./connections.js";

const openDbs: Array<() => void> = [];
function makeLedger(): DrizzleGrantLedger {
  const { db, close } = createTestDb();
  openDbs.push(close);
  return new DrizzleGrantLedger(db);
}

afterEach(() => {
  while (openDbs.length) openDbs.pop()?.();
});

function fakePersonMappingRepo(): PersonMappingRepository {
  return {
    writeDeleteGuardianChannelMappings: rs.fn(),
  } as unknown as PersonMappingRepository;
}

function makeApp(
  registry: ConnectionRegistry,
  personMappingRepo = fakePersonMappingRepo(),
  overrides: Partial<ApiDeps> = {},
): Hono {
  const { db, close } = createTestDb();
  openDbs.push(close);
  return new Hono().route(
    "/",
    connectionsRoutes({
      db,
      approvalsRepo: new ApprovalsRepository(
        db,
        new PersonMappingRepository(db, identityServiceOf),
      ),
      connectionRegistry: registry,
      personMappingRepo,
      ...overrides,
    } as ApiDeps),
  );
}

const SAME_ORIGIN = { "sec-fetch-site": "same-origin" };

/** The pasteTalk (telegram-like) fixture plus a reviveProfile hook, so the
 *  route's display projection has a service-owned schema to go through. */
function makePasteTalkWithProfile() {
  const fixture = makePasteTalk();
  fixture.descriptor.reviveProfile = (_grant, record: ProfileRecord) => ({
    displayName: record.name as string | undefined,
    handle: record.login as string | undefined,
    email: undefined,
    avatarUrl: undefined,
  });
  return fixture;
}

describe("GET /connections", () => {
  it("lists every connection with grants, capabilities, and revived display", async () => {
    const registry = new ConnectionRegistry({ ledger: makeLedger() });
    const telegram = makePasteTalkWithProfile();
    const discord = makeTwoGrant();
    registry.register(telegram.descriptor);
    registry.register(discord.descriptor);

    const tg = await registry.connect("fake-telegram", "Telegram");
    await registry.connect("fake-discord", "Discord");
    await registry.importCredential(tg.id, "bot", telegram.validCredential(), {
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
      service: "fake-telegram",
      label: "Telegram",
      grants: { bot: "authorized" },
      display: {
        bot: { displayName: "Rome Bot", handle: "rome_bot", email: null, avatarUrl: null },
      },
      capabilities: {
        talk: { state: "unlocked" },
        act: { state: "unsupported" },
        watch: { state: "unsupported" },
      },
      connect: null,
      setups: {},
      channel: null,
      severalAccounts: false,
    });

    // Nothing conferred on discord yet: both grants unauthorized, everything
    // needing them locked, and no display (no profile AND no reviveProfile).
    expect(d.label).toBe("Discord");
    expect(d.grants).toEqual({ bot: "unauthorized", user: "unauthorized" });
    expect(d.display).toEqual({ bot: null, user: null });
    expect(d.capabilities.talk).toEqual({ state: "needs-auth", missingGrants: ["bot"] });
    expect(d.capabilities.act).toEqual({ state: "needs-auth", missingGrants: ["user"] });
  });

  it("shows Discord-style partial availability: degraded user relocks act, talk stays unlocked", async () => {
    const ledger = makeLedger();
    {
      const setup = new ConnectionRegistry({ ledger });
      const fixture = makeTwoGrant();
      setup.register(fixture.descriptor);
      const conn = await setup.connect("fake-discord", "Discord");
      await setup.importCredential(conn.id, "bot", fixture.botCredential());
      await setup.importCredential(conn.id, "user", fixture.userCredential());
      await ledger.updateGrant(conn.id, "user", {
        state: "degraded",
        degraded: { at: new Date("2026-07-13T00:00:00Z"), reason: "token revoked upstream" },
      });
    }
    // Fresh registry over the same ledger — the boot-shaped path to a degraded grant.
    const registry = new ConnectionRegistry({ ledger });
    registry.register(makeTwoGrant().descriptor);
    await registry.load();

    const res = await makeApp(registry).request("/connections");
    const { connections } = await res.json();
    const [d] = connections;

    expect(d.grants).toEqual({ bot: "authorized", user: "degraded" });
    expect(d.capabilities.talk).toEqual({ state: "unlocked" });
    expect(d.capabilities.act).toEqual({ state: "needs-auth", missingGrants: ["user"] });
  });

  it("surfaces needs-subscription for a gated watch with no active subscription", async () => {
    const registry = new ConnectionRegistry({ ledger: makeLedger() });
    registry.register(makeGatedWatch().descriptor);
    const conn = await registry.connect("fake-github-watch");

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
    const registry = new ConnectionRegistry({ ledger: makeLedger() });
    const telegram = makePasteTalkWithProfile();
    const discord = makeTwoGrant();
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
      service: "fake-discord",
      label: "fake-discord",
      grants: { bot: "unauthorized", user: "unauthorized" },
      display: { bot: null, user: null },
      capabilities: {
        talk: { state: "needs-auth", missingGrants: ["bot"] },
        act: { state: "needs-auth", missingGrants: ["user"] },
        watch: { state: "needs-auth", missingGrants: ["bot"] },
      },
      connect: null,
      setups: {},
      channel: null,
      severalAccounts: false,
    });
  });

  it("offers OAuth placeholders only for host-enabled providers", async () => {
    const prev = process.env.SHOW_GOOGLE_OAUTH;
    delete process.env.SHOW_GOOGLE_OAUTH;
    try {
      const registry = new ConnectionRegistry({ ledger: makeLedger() });
      // Both descriptors register unconditionally (existing accounts must
      // import regardless), but only enabled providers are connect invitations.
      for (const provider of ["github", "google"]) {
        registry.register({
          service: provider,
          auth: { user: tokenPaste({ label: "token", validate: async () => {} }) },
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
      const registry = new ConnectionRegistry({ ledger: makeLedger() });
      registry.register({
        service: "github",
        auth: { user: tokenPaste({ label: "token", validate: async () => {} }) },
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
      ledger: makeLedger(),
      clock: () => new Date("2026-07-13T12:00:00Z"),
    });
    const fixture = makeTwoGrant();
    registry.register(fixture.descriptor);
    const conn = await registry.connect("fake-discord", "Discord");
    await registry.importCredential(conn.id, "bot", fixture.botCredential());
    const expiring: Credential = {
      material: { token: "fake-discord-user-token" },
      expiresAt: new Date("2026-08-01T00:00:00Z"),
    };
    await registry.importCredential(conn.id, "user", expiring);

    const res = await makeApp(registry).request(`/connections/${conn.id}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const { connection } = await res.json();

    expect(connection.id).toBe(conn.id);
    expect(connection.grants).toEqual({ bot: "authorized", user: "authorized" });
    expect(connection.grantDetails).toEqual({
      bot: {
        conferredAt: "2026-07-13T12:00:00.000Z",
        lastRenewedAt: null,
        degraded: null,
        tokenExpiresAt: null,
      },
      user: {
        conferredAt: "2026-07-13T12:00:00.000Z",
        lastRenewedAt: null,
        degraded: null,
        tokenExpiresAt: "2026-08-01T00:00:00.000Z",
      },
    });
  });

  it("carries the degraded reason in grant detail", async () => {
    const ledger = makeLedger();
    const registry = new ConnectionRegistry({ ledger });
    const fixture = makeTwoGrant();
    registry.register(fixture.descriptor);
    const conn = await registry.connect("fake-discord", "Discord");
    await registry.importCredential(conn.id, "user", fixture.userCredential());
    await ledger.updateGrant(conn.id, "user", {
      state: "degraded",
      degraded: { at: new Date("2026-07-13T00:00:00Z"), reason: "token revoked upstream" },
    });

    const res = await makeApp(registry).request(`/connections/${conn.id}`);
    const { connection } = await res.json();
    expect(connection.grantDetails.user.degraded).toEqual({
      at: "2026-07-13T00:00:00.000Z",
      reason: "token revoked upstream",
    });
  });

  it("404s an unknown connection id", async () => {
    const registry = new ConnectionRegistry({ ledger: makeLedger() });
    const res = await makeApp(registry).request("/connections/nope");
    expect(res.status).toBe(404);
  });
});

describe("DELETE /connections/:id/grants/:name", () => {
  it("revokes the grant and relocks only its capabilities", async () => {
    const registry = new ConnectionRegistry({ ledger: makeLedger() });
    const fixture = makeTwoGrant();
    const personMappingRepo = fakePersonMappingRepo();
    registry.register(fixture.descriptor);
    const conn = await registry.connect("fake-discord", "Discord");
    await registry.importCredential(conn.id, "bot", fixture.botCredential());
    await registry.importCredential(conn.id, "user", fixture.userCredential());

    const res = await makeApp(registry, personMappingRepo).request(
      `/connections/${conn.id}/grants/user`,
      {
        method: "DELETE",
        headers: SAME_ORIGIN,
      },
    );
    expect(res.status).toBe(200);
    const { connection } = await res.json();

    expect(connection.grants).toEqual({ bot: "authorized", user: "unauthorized" });
    expect(connection.capabilities.act).toEqual({ state: "needs-auth", missingGrants: ["user"] });
    expect(connection.capabilities.talk).toEqual({ state: "unlocked" });
    // The talk epoch survived the sibling revoke; only act was torn down.
    expect(fixture.talkerFactory.instances[0].state.stopCount).toBe(0);
    expect(personMappingRepo.writeDeleteGuardianChannelMappings).not.toHaveBeenCalled();
  });

  it("clears the channel guardian mapping when its Talk grant is revoked", async () => {
    const registry = new ConnectionRegistry({ ledger: makeLedger() });
    const fixture = makePasteTalk();
    const personMappingRepo = fakePersonMappingRepo();
    registry.register(fixture.descriptor);
    const conn = await registry.connect("fake-telegram");
    await registry.importCredential(conn.id, "bot", fixture.validCredential());

    const res = await makeApp(registry, personMappingRepo).request(
      `/connections/${conn.id}/grants/bot`,
      {
        method: "DELETE",
        headers: SAME_ORIGIN,
      },
    );

    expect(res.status).toBe(200);
    expect(personMappingRepo.writeDeleteGuardianChannelMappings).toHaveBeenCalledWith(
      expect.anything(),
      "fake-telegram",
    );
  });

  it("404s an unknown grant name and an unknown connection", async () => {
    const registry = new ConnectionRegistry({ ledger: makeLedger() });
    registry.register(makeTwoGrant().descriptor);
    const conn = await registry.connect("fake-discord");

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
    const registry = new ConnectionRegistry({ ledger: makeLedger() });
    const fixture = makeTwoGrant();
    registry.register(fixture.descriptor);
    const conn = await registry.connect("fake-discord");
    await registry.importCredential(conn.id, "user", fixture.userCredential());

    const res = await makeApp(registry).request(`/connections/${conn.id}/grants/user`, {
      method: "DELETE",
      headers: { "sec-fetch-site": "cross-site" },
    });
    expect(res.status).toBe(403);
    expect(registry.get(conn.id).auth.grants().user).toBe("authorized");
  });
});

describe("POST /connections", () => {
  const telegram = makePasteTalk();
  function telegramRegistry(): ConnectionRegistry {
    const registry = new ConnectionRegistry({ ledger: makeLedger() });
    registry.register({ ...telegram.descriptor, service: "telegram", severalAccounts: true });
    return registry;
  }
  const addAccount = (registry: ConnectionRegistry) =>
    makeApp(registry).request("/connections", {
      method: "POST",
      headers: { ...SAME_ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ service: "telegram" }),
    });

  it("mints another Connection of a service that offers several accounts", async () => {
    const registry = telegramRegistry();
    const first = await registry.connect("telegram");
    await registry.importCredential(first.id, "bot", telegram.validCredential());

    const res = await addAccount(registry);

    expect(res.status).toBe(201);
    const { connection } = await res.json();
    expect(connection).toMatchObject({ service: "telegram", severalAccounts: true });
    expect(connection.id).not.toBe(first.id);
    expect(registry.find("telegram")).toHaveLength(2);
  });

  it("reports each account's channel: the service name first, an opaque id after", async () => {
    const { db, close } = createTestDb();
    openDbs.push(close);
    const records = new ChannelRecordsRepository(db);
    const registry = new ConnectionRegistry({
      ledger: new DrizzleGrantLedger(db),
      onMint: (tx, record) => {
        records.claim(tx, record, record.createdAt);
      },
    });
    registry.register({ ...telegram.descriptor, service: "telegram", severalAccounts: true });
    const first = await registry.connect("telegram");
    await registry.importCredential(first.id, "bot", telegram.validCredential());
    const app = makeApp(registry, undefined, { db });

    const added = await app.request("/connections", {
      method: "POST",
      headers: { ...SAME_ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ service: "telegram" }),
    });
    const { connection } = await added.json();
    const { connections } = await (await app.request("/connections")).json();

    const channelOf = (id: string) =>
      connections.find((each: { id: string }) => each.id === id)?.channel;
    expect(channelOf(first.id)).toBe("telegram");
    expect(channelOf(connection.id)).toBe(records.idOf(connection.id));
    expect(channelOf(connection.id)).not.toBe("telegram");
  });

  it("hands back an account whose setup never finished instead of minting", async () => {
    const registry = telegramRegistry();
    const first = await registry.connect("telegram");
    await registry.importCredential(first.id, "bot", telegram.validCredential());
    const added = await (await addAccount(registry)).json();

    const res = await addAccount(registry);

    expect(res.status).toBe(200);
    expect((await res.json()).connection.id).toBe(added.connection.id);
    expect(registry.find("telegram")).toHaveLength(2);
  });

  it("mints rather than hand back an account whose bot was disconnected", async () => {
    const registry = telegramRegistry();
    const first = await registry.connect("telegram");
    await registry.importCredential(first.id, "bot", telegram.validCredential());
    await registry.revoke(first.id, "bot");

    const res = await addAccount(registry);

    expect(res.status).toBe(201);
    expect((await res.json()).connection.id).not.toBe(first.id);
  });

  it("gives two overlapping requests the same new account", async () => {
    const registry = telegramRegistry();
    const first = await registry.connect("telegram");
    await registry.importCredential(first.id, "bot", telegram.validCredential());

    const [a, b] = await Promise.all([addAccount(registry), addAccount(registry)]);

    const ids = [(await a.json()).connection.id, (await b.json()).connection.id];
    expect(ids[0]).toBe(ids[1]);
    expect(registry.find("telegram")).toHaveLength(2);
  });

  it("refuses a service that offers one account", async () => {
    const registry = new ConnectionRegistry({ ledger: makeLedger() });
    registry.register(makePasteTalk().descriptor);

    const res = await makeApp(registry).request("/connections", {
      method: "POST",
      headers: { ...SAME_ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ service: "fake-telegram" }),
    });

    expect(res.status).toBe(400);
    expect(registry.find("fake-telegram")).toEqual([]);
  });

  it("refuses a null body", async () => {
    const registry = telegramRegistry();

    const res = await makeApp(registry).request("/connections", {
      method: "POST",
      headers: { ...SAME_ORIGIN, "content-type": "application/json" },
      body: "null",
    });

    expect(res.status).toBe(400);
    expect(registry.find("telegram")).toEqual([]);
  });

  it("rejects cross-site requests without minting", async () => {
    const registry = telegramRegistry();

    const res = await makeApp(registry).request("/connections", {
      method: "POST",
      headers: { "sec-fetch-site": "cross-site", "content-type": "application/json" },
      body: JSON.stringify({ service: "telegram" }),
    });

    expect(res.status).toBe(403);
    expect(registry.find("telegram")).toEqual([]);
  });
});

describe("DELETE /connections/:id", () => {
  it("removes the connection from the list and the ledger", async () => {
    const ledger = makeLedger();
    const registry = new ConnectionRegistry({ ledger });
    const fixture = makePasteTalkWithProfile();
    const personMappingRepo = fakePersonMappingRepo();
    registry.register(fixture.descriptor);
    const conn = await registry.connect("fake-telegram", "Telegram");
    await registry.importCredential(conn.id, "bot", fixture.validCredential());

    const app = makeApp(registry, personMappingRepo);
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
    expect(await ledger.listConnections()).toEqual([]);
    // The live talk epoch was torn down with the connection.
    expect(fixture.talkerFactory.instances[0].state.stopCount).toBe(1);
    // Guardian mapping cleanup is enlisted in the deletion transaction (called
    // with the tx participant), not as a separate best-effort write.
    expect(personMappingRepo.writeDeleteGuardianChannelMappings).toHaveBeenCalledWith(
      expect.anything(),
      "fake-telegram",
    );
  });

  it("rolls the connection deletion back when guardian-mapping cleanup fails", async () => {
    const ledger = makeLedger();
    const registry = new ConnectionRegistry({ ledger });
    const fixture = makePasteTalkWithProfile();
    const personMappingRepo = fakePersonMappingRepo();
    (
      personMappingRepo.writeDeleteGuardianChannelMappings as ReturnType<typeof rs.fn>
    ).mockImplementation(() => {
      throw new Error("mapping cleanup boom");
    });
    registry.register(fixture.descriptor);
    const conn = await registry.connect("fake-telegram", "Telegram");
    await registry.importCredential(conn.id, "bot", fixture.validCredential());

    const app = makeApp(registry, personMappingRepo);
    const res = await app.request(`/connections/${conn.id}`, {
      method: "DELETE",
      headers: SAME_ORIGIN,
    });
    expect(res.status).toBe(500);

    // The mapping delete is enlisted in the SAME transaction as the connection/
    // grant deletes, so its failure rolls the whole thing back: the connection
    // and its grant survive (a retry can still succeed) and the in-memory
    // connection is never evicted — no stale mapping against a deleted row.
    expect(await ledger.listConnections()).toHaveLength(1);
    expect(registry.get(conn.id).id).toBe(conn.id);
    expect(fixture.talkerFactory.instances[0].state.stopCount).toBe(0);
  });

  it("404s an unknown connection and rejects cross-site requests", async () => {
    const registry = new ConnectionRegistry({ ledger: makeLedger() });
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

describe("guardian links across Connections of one service", () => {
  async function twoBots() {
    const { db, close } = createTestDb();
    openDbs.push(close);
    const registry = new ConnectionRegistry({ ledger: new DrizzleGrantLedger(db) });
    const fixture = makePasteTalk();
    fixture.descriptor.service = "telegram";
    registry.register(fixture.descriptor);
    const first = await registry.connect("telegram");
    const second = await registry.connectAnother("telegram");
    await registry.importCredential(first.id, "bot", fixture.validCredential());
    await registry.importCredential(second.id, "bot", fixture.validCredential());
    const personMappingRepo = new PersonMappingRepository(db, identityServiceOf);
    await personMappingRepo.create({
      displayName: "Guardian",
      bondLevel: "guardian",
      channelMappings: [{ channel: "telegram", channelUserId: "guardian" }],
    });
    const app = makeApp(registry, personMappingRepo, {
      db,
      approvalsRepo: new ApprovalsRepository(db, personMappingRepo),
    });
    const del = (path: string) => app.request(path, { method: "DELETE", headers: SAME_ORIGIN });
    return { registry, personMappingRepo, first, second, del };
  }

  it("keeps the guardian link when one of two bots is removed", async () => {
    const { personMappingRepo, first, del } = await twoBots();

    expect((await del(`/connections/${first.id}`)).status).toBe(200);
    expect(await personMappingRepo.findByChannelUser("telegram", "guardian")).not.toBeNull();
  });

  it("keeps the guardian link when one of two bots loses Talk", async () => {
    const { personMappingRepo, first, del } = await twoBots();

    expect((await del(`/connections/${first.id}/grants/bot`)).status).toBe(200);
    expect(await personMappingRepo.findByChannelUser("telegram", "guardian")).not.toBeNull();
  });

  it("keeps the guardian link while the other bot's Talk is only degraded", async () => {
    const { registry, personMappingRepo, first, second, del } = await twoBots();
    await registry.getLedger().updateGrant(second.id, "bot", {
      state: "degraded",
      degraded: { at: new Date(0), reason: "renewal rejected" },
    });

    expect((await del(`/connections/${first.id}`)).status).toBe(200);
    expect(await personMappingRepo.findByChannelUser("telegram", "guardian")).not.toBeNull();
  });

  it("keeps the guardian link when one of two Connections whose Talk needs no grant is removed", async () => {
    const { db, close } = createTestDb();
    openDbs.push(close);
    const registry = new ConnectionRegistry({ ledger: new DrizzleGrantLedger(db) });
    registry.register(makeZeroGrantTalk().descriptor);
    const first = await registry.connect("fake-webchat");
    await registry.connectAnother("fake-webchat");
    const personMappingRepo = new PersonMappingRepository(db, identityServiceOf);
    await personMappingRepo.create({
      displayName: "Guardian",
      bondLevel: "guardian",
      channelMappings: [{ channel: "fake-webchat", channelUserId: "guardian" }],
    });
    const app = makeApp(registry, personMappingRepo, {
      db,
      approvalsRepo: new ApprovalsRepository(db, personMappingRepo),
    });

    const removed = await app.request(`/connections/${first.id}`, {
      method: "DELETE",
      headers: SAME_ORIGIN,
    });
    expect(removed.status).toBe(200);
    expect(await personMappingRepo.findByChannelUser("fake-webchat", "guardian")).not.toBeNull();
  });

  it("deletes the guardian link when the last bot is removed", async () => {
    const { personMappingRepo, first, second, del } = await twoBots();

    expect((await del(`/connections/${first.id}`)).status).toBe(200);
    expect((await del(`/connections/${second.id}`)).status).toBe(200);
    expect(await personMappingRepo.findByChannelUser("telegram", "guardian")).toBeNull();
  });

  it("deletes the guardian link when the other bot no longer has Talk", async () => {
    const { personMappingRepo, first, second, del } = await twoBots();

    expect((await del(`/connections/${second.id}/grants/bot`)).status).toBe(200);
    expect(await personMappingRepo.findByChannelUser("telegram", "guardian")).not.toBeNull();
    expect((await del(`/connections/${first.id}`)).status).toBe(200);
    expect(await personMappingRepo.findByChannelUser("telegram", "guardian")).toBeNull();
  });
});

describe("connection pairing teardown", () => {
  it.each([
    "connection",
    "talk",
    "unrelated",
    "rollback",
    "talk-rollback",
  ])("%s teardown preserves only requests that still have Talk authorization", async (teardown) => {
    const { db, close } = createTestDb();
    openDbs.push(close);
    const ledger = new DrizzleGrantLedger(db);
    const registry = new ConnectionRegistry({ ledger });
    const fixture = makeTwoGrant();
    fixture.descriptor.service = "discord";
    registry.register(fixture.descriptor);
    const conn = await registry.connect("discord");
    await registry.importCredential(conn.id, "bot", fixture.botCredential());
    await registry.importCredential(conn.id, "user", fixture.userCredential());
    const personMappingRepo = new PersonMappingRepository(db, identityServiceOf);
    await personMappingRepo.create({
      displayName: "Guardian",
      bondLevel: "guardian",
      channelMappings: [{ channel: "discord", channelUserId: "paired" }],
    });
    const approvalsRepo = new ApprovalsRepository(
      db,
      new PersonMappingRepository(db, identityServiceOf),
      () => Buffer.alloc(32, 1),
    );
    const input = {
      connectionId: conn.id,
      channel: "discord" as const,
      channelUserId: "requester",
      displayName: "Requester",
    };
    const request = approvalsRepo.requestPairing(input)!;
    const code = (await approvalsRepo.pairingCode(request.approval.id))!;
    const other = approvalsRepo.requestPairing({
      ...input,
      connectionId: "other",
      channelUserId: "other",
    })!;
    const app = makeApp(registry, personMappingRepo, { db, approvalsRepo });
    if (teardown.endsWith("rollback")) {
      rs.spyOn(personMappingRepo, "writeDeleteGuardianChannelMappings").mockImplementation(() => {
        throw new Error("cleanup failed");
      });
    }
    const suffix =
      teardown === "connection" || teardown === "rollback"
        ? ""
        : `/grants/${teardown.startsWith("talk") ? "bot" : "user"}`;
    const response = await app.request(`/connections/${conn.id}${suffix}`, {
      method: "DELETE",
      headers: SAME_ORIGIN,
    });
    if (teardown.endsWith("rollback")) {
      expect(response.status).toBe(500);
      expect(await ledger.listConnections()).toHaveLength(1);
      expect(registry.get(conn.id).auth.grants().bot).toBe("authorized");
      expect((await ledger.getGrant(conn.id, "bot"))?.credential).toBeDefined();
      expect(fixture.talkerFactory.instances[0].state.stopCount).toBe(0);
      expect(await personMappingRepo.findByChannelUser("discord", "paired")).not.toBeNull();
      expect((await approvalsRepo.findById(request.approval.id))?.status).toBe("pending");
      return;
    }
    expect(response.status).toBe(200);
    expect((await approvalsRepo.findById(other.approval.id))?.status).toBe("pending");
    if (teardown === "unrelated") {
      expect(approvalsRepo.verifyPairing({ ...input, code }).outcome).toBe("resolved");
      return;
    }
    expect((await approvalsRepo.findById(request.approval.id))?.payload).toMatchObject({
      resolution: "superseded",
    });
    expect(await approvalsRepo.pairingCode(request.approval.id)).toBeNull();
    expect(
      (await approvalsRepo.resolvePending(request.approval.id, "approve", "guardian")).outcome,
    ).toBe("already_resolved");
    expect(approvalsRepo.verifyPairing({ ...input, code }).outcome).toBe("invalid_code");
    expect(await personMappingRepo.findByChannelUser("discord", "requester")).toBeNull();
    expect(await personMappingRepo.findByChannelUser("discord", "paired")).toBeNull();
    const reconnected = teardown === "connection" ? await registry.connect("discord") : conn;
    await registry.importCredential(reconnected.id, "bot", fixture.botCredential());
    const fresh = approvalsRepo.requestPairing({ ...input, connectionId: reconnected.id });
    expect(fresh?.approval.id).toBeDefined();
    expect(fresh?.approval.id).not.toBe(request.approval.id);
  });
});
