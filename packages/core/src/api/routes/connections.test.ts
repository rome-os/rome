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
import { makeGatedWatch, makePasteTalk, makeTwoGrant } from "../../connections/test-fixtures.js";
import type { Credential, ProfileRecord } from "../../connections/types.js";
import type { PersonMappingRepository } from "../../db/repositories/person-mapping.js";
import { createTestDb } from "../../test/helpers.js";
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
    deleteGuardianChannelMappings: rs.fn(),
    writeDeleteGuardianChannelMappings: rs.fn(),
  } as unknown as PersonMappingRepository;
}

function makeApp(registry: ConnectionRegistry, personMappingRepo = fakePersonMappingRepo()): Hono {
  return new Hono().route(
    "/",
    connectionsRoutes({ connectionRegistry: registry, personMappingRepo } as unknown as ApiDeps),
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
    expect(personMappingRepo.deleteGuardianChannelMappings).not.toHaveBeenCalled();
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
    expect(personMappingRepo.deleteGuardianChannelMappings).toHaveBeenCalledOnce();
    expect(personMappingRepo.deleteGuardianChannelMappings).toHaveBeenCalledWith("fake-telegram");
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
    expect(personMappingRepo.deleteGuardianChannelMappings).not.toHaveBeenCalled();
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
