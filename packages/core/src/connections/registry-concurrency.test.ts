// Per-grant lock (#1592): registry lifecycle mutations serialize.
//
// The connection registry serializes every guardian-facing grant lifecycle
// mutation — conferral (importCredential), revoke, and profile backfill —
// through a promise-chain mutex keyed per (connection, grant). These tests pin
// the interleavings entirely through the registry's PUBLIC surface: a gated
// ledger parks one mutation mid-write, a competitor is fired through the same
// API, the gate is released, and the final grant state + ledger row are
// asserted. The lock and the chain map themselves have no direct tests.
//
// Each interleaving test is red without the lock (the parked, earlier-issued
// mutation lands its write last and wins, contradicting later-issued-wins /
// splits memory from the ledger) and green with it.

import { describe, expect, it } from "@rstest/core";
import { createTestDb } from "../test/helpers.js";
import { DrizzleGrantLedger } from "./ledger-db.js";
import type { GrantLedger, GrantRecord } from "./ledger.js";
import { ConnectionRegistry } from "./registry.js";
import { makePasteTalk, makeTwoGrant } from "./test-fixtures.js";

// A macrotask flush: lets the queued mutation bodies (which run on microtasks
// off the promise chain) reach their first awaited ledger write before we act.
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function makeLedger(): GrantLedger {
  return new DrizzleGrantLedger(createTestDb().db);
}

/** Wrap a ledger so the FIRST `updateGrant` whose (custody, name, patch) matches
 *  `shouldGate` parks on a test-controlled gate before delegating. Every other
 *  call — including the competitor's writes and any later write from the parked
 *  flow itself — passes straight through. Models a single slow durable write so
 *  a competing mutation can complete INSIDE the gated one's awaited ledger call
 *  (the exact window the per-grant lock closes). */
function makeGatedLedger(
  inner: GrantLedger,
  shouldGate: (custody: string, name: string, patch: Record<string, unknown>) => boolean,
): { ledger: GrantLedger; release: () => void } {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let gatedOnce = false;
  const ledger: GrantLedger = {
    createConnection: (rec) => inner.createConnection(rec),
    listConnections: () => inner.listConnections(),
    deleteConnection: (id) => inner.deleteConnection(id),
    ensureGrant: (custody, name) => inner.ensureGrant(custody, name),
    getGrant: (custody, name) => inner.getGrant(custody, name),
    listGrants: (custody) => inner.listGrants(custody),
    async updateGrant(custody, name, patch) {
      if (!gatedOnce && shouldGate(custody, name, patch as Record<string, unknown>)) {
        gatedOnce = true;
        await gate;
      }
      return inner.updateGrant(custody, name, patch);
    },
  };
  return { ledger, release };
}

describe("per-grant lock: same-grant mutations serialize", () => {
  // Acceptance: concurrent conferral + revoke on the same grant — the
  // later-issued operation (revoke) wins; the grant ends in that operation's
  // state with a consistent ledger row.
  it("conferral then revoke: the later-issued revoke wins with a consistent ledger row", async () => {
    // Park the conferral's authorize write. Without the lock the revoke runs to
    // completion during the park, then the released conferral write lands LAST
    // and the grant ends (wrongly) authorized. With the lock the revoke is
    // queued behind the conferral and applies last — revoke wins.
    const { ledger, release } = makeGatedLedger(
      makeLedger(),
      (_c, _n, patch) => patch.state === "authorized",
    );
    const registry = new ConnectionRegistry({ ledger });
    const fx = makePasteTalk();
    registry.register(fx.descriptor);
    const conn = await registry.connect("fake-telegram");

    const conferral = registry.importCredential(conn.id, "bot", fx.validCredential());
    const revoke = conn.auth.revoke("bot");

    // Let the conferral reach and park on its authorize write.
    await flush();
    expect(conn.auth.grants().bot).toBe("unauthorized"); // conferral parked, revoke queued

    release();
    await Promise.all([conferral, revoke]);

    // Later-issued revoke wins: memory and ledger agree on unauthorized, no cred.
    expect(conn.auth.grants().bot).toBe("unauthorized");
    expect(conn.talk).toBeNull();
    const rec = await ledger.getGrant(conn.id, "bot");
    expect(rec?.state).toBe("unauthorized");
    expect(rec?.credential).toBeUndefined();
  });

  // Acceptance: concurrent conferral + conferral on the same grant — exactly one
  // final authorized grant whose credential, profile, and conferredAt are ONE
  // conferral's complete outcome (the later-issued one), with no field mixing
  // and no split between the ledger row and the live in-memory credential.
  it("two conferrals: the later-issued one's complete outcome wins, no field mixing", async () => {
    const { ledger, release } = makeGatedLedger(
      makeLedger(),
      (_c, _n, patch) => patch.state === "authorized",
    );
    // Monotonic clock so the two conferrals stamp distinct conferredAt values:
    // connect() takes tick 1 (createdAt), conferral #1 tick 2, conferral #2 tick 3.
    let tick = 0;
    const registry = new ConnectionRegistry({ ledger, clock: () => new Date(1000 * ++tick) });
    const fx = makePasteTalk();
    registry.register(fx.descriptor);
    const conn = await registry.connect("fake-telegram");

    const first = registry.importCredential(
      conn.id,
      "bot",
      { material: { token: "tok1" }, expiresAt: "never" },
      { login: "one" },
    );
    const second = registry.importCredential(
      conn.id,
      "bot",
      { material: { token: "tok2" }, expiresAt: "never" },
      { login: "two" },
    );

    await flush(); // first conferral parks on its authorize write
    release();
    await Promise.all([first, second]);

    // The final ledger row is the SECOND conferral's complete triple.
    const rec = await ledger.getGrant(conn.id, "bot");
    expect(rec?.state).toBe("authorized");
    expect(rec?.credential?.material).toEqual({ kind: "inline", record: { token: "tok2" } });
    expect(rec?.profile).toEqual({ login: "two" });
    // conferredAt is the later conferral's stamp (tick 3), never mixed with #1's.
    expect((rec?.conferredAt as Date).getTime()).toBe(3000);

    // No split-brain: the live capability was built with the SAME credential the
    // ledger row records (tok2), not the earlier conferral's tok1.
    const latest = fx.talkerFactory.instances.at(-1);
    expect(latest?.state.starts.at(-1)?.creds.bot.material).toEqual({ token: "tok2" });
    expect(conn.auth.grants().bot).toBe("authorized");
  });
});

describe("per-grant lock: independent grants do not serialize", () => {
  // Acceptance: mutations on DIFFERENT grants of the same connection are keyed
  // to independent chains — a parked conferral on one grant must not block a
  // conferral on another. A global (mis-keyed) lock would hang the second call.
  it("a parked conferral on one grant does not block a conferral on another grant", async () => {
    const { ledger, release } = makeGatedLedger(
      makeLedger(),
      (_c, name, patch) => name === "bot" && patch.state === "authorized",
    );
    const registry = new ConnectionRegistry({ ledger });
    const fx = makeTwoGrant();
    registry.register(fx.descriptor);
    const conn = await registry.connect("fake-discord");

    const botConferral = registry.importCredential(conn.id, "bot", fx.botCredential());
    const userConferral = registry.importCredential(conn.id, "user", fx.userCredential());

    // The user conferral completes while the bot conferral is still parked —
    // proof the two grants hold independent chains.
    await userConferral;
    expect(conn.auth.grants().user).toBe("authorized");
    expect(conn.auth.grants().bot).toBe("unauthorized");

    release();
    await botConferral;
    expect(conn.auth.grants().bot).toBe("authorized");
  });

  // Acceptance: mutations on DIFFERENT Services/connections do not serialize —
  // each ConnectionImpl owns its own per-grant chains. (The v1 registry permits
  // exactly one connection per Service.)
  it("a parked conferral on one connection does not block another connection's conferral", async () => {
    const fx = makePasteTalk();
    const base = makeLedger();
    // Gate only connection A's authorize write.
    let connAId = "";
    const { ledger, release } = makeGatedLedger(
      base,
      (custody, _n, patch) => custody === connAId && patch.state === "authorized",
    );
    const registry = new ConnectionRegistry({ ledger });
    registry.register(fx.descriptor);
    registry.register({ ...fx.descriptor, service: "fake-signal" });
    const connA = await registry.connect("fake-telegram");
    const connB = await registry.connect("fake-signal");
    connAId = connA.id;

    const aConferral = registry.importCredential(connA.id, "bot", fx.validCredential());
    const bConferral = registry.importCredential(connB.id, "bot", fx.validCredential());

    // Connection B's conferral completes while A's is still parked.
    await bConferral;
    expect(connB.auth.grants().bot).toBe("authorized");
    expect(connA.auth.grants().bot).toBe("unauthorized");

    release();
    await aConferral;
    expect(connA.auth.grants().bot).toBe("authorized");
  });
});

describe("per-grant lock: profile backfill serializes with conferral", () => {
  // backfillProfile is one of the three serialized mutations. A backfill issued
  // after a conferral must apply after it (FIFO), leaving the conferral's
  // credential intact and the backfilled profile on the row.
  it("a conferral then a profile backfill on the same grant apply in issue order", async () => {
    const { ledger, release } = makeGatedLedger(
      makeLedger(),
      (_c, _n, patch) => patch.state === "authorized",
    );
    const registry = new ConnectionRegistry({ ledger });
    const fx = makePasteTalk();
    registry.register(fx.descriptor);
    const conn = await registry.connect("fake-telegram");

    const conferral = registry.importCredential(
      conn.id,
      "bot",
      { material: { token: "tok" }, expiresAt: "never" },
      { login: "before" },
    );
    const backfill = registry.backfillProfile(conn.id, "bot", { login: "after" });

    await flush(); // conferral parks on its authorize write; backfill queued behind it
    release();
    await Promise.all([conferral, backfill]);

    const rec: GrantRecord | null = await ledger.getGrant(conn.id, "bot");
    expect(rec?.state).toBe("authorized");
    // The backfill ran last: its profile is on the row, the conferral's
    // credential untouched.
    expect(rec?.profile).toEqual({ login: "after" });
    expect(rec?.credential?.material).toEqual({ kind: "inline", record: { token: "tok" } });
  });
});
