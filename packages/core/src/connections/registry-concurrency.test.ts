// Per-grant lock (#1592): registry lifecycle mutations serialize.
//
// The connection registry serializes every guardian-facing grant lifecycle
// mutation — conferral, revoke, and profile backfill —
// through a promise-chain mutex keyed per (connection, grant). These tests pin
// the interleavings entirely through the registry's PUBLIC surface: a gated
// custody sync parks one mutation inside its lock, a competitor is fired through the same
// API, the gate is released, and the final grant state + ledger row are
// asserted. The lock and the chain map themselves have no direct tests.
//
// Each interleaving test is red without the lock (the parked, earlier-issued
// mutation lands its write last and wins, contradicting later-issued-wins /
// splits memory from the ledger) and green with it.

import { describe, expect, it } from "@rstest/core";
import { createTestDb } from "../test/helpers.js";
import { DrizzleConnectionsRepository } from "./repository-db.js";
import type { ConnectionsRepository } from "./repository.js";
import { ConnectionRegistry } from "./registry.js";
import { makePasteTalk } from "./test-fixtures.js";
import type { GrantCustody } from "./types.js";

// A macrotask flush: lets the queued mutation bodies (which run on microtasks
// off the promise chain) reach their first awaited ledger write before we act.
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Custody whose FIRST sync parks on a test-controlled gate. A conferral syncs
 *  custody while it holds the grant's lock, after its write committed, so a
 *  parked sync holds a conferral mid-flight inside the lock: the window a
 *  competing mutation must wait out. Every later sync passes straight through. */
function makeGatedCustody(): { custody: GrantCustody; release: () => void } {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let gatedOnce = false;
  const custody: GrantCustody = {
    async sync() {
      if (gatedOnce) return;
      gatedOnce = true;
      await gate;
    },
    async clear() {},
  };
  return { custody, release };
}

function makeLedger(): ConnectionsRepository {
  return new DrizzleConnectionsRepository(createTestDb().db);
}

describe("per-grant lock: same-grant mutations serialize", () => {
  // Acceptance: concurrent conferral + revoke on the same grant — the
  // later-issued operation (revoke) wins; the grant ends in that operation's
  // state with a consistent ledger row.
  it("conferral then revoke: the later-issued revoke wins with a consistent ledger row", async () => {
    // Park the conferral inside its grant lock. Without the lock the revoke
    // runs to completion during the park, then the conferral's activation
    // finishes LAST and the grant ends (wrongly) live. With the lock the revoke
    // is queued behind the conferral and applies last — revoke wins.
    const { custody, release } = makeGatedCustody();
    const ledger = makeLedger();
    const registry = new ConnectionRegistry({ repository: ledger });
    const fx = makePasteTalk();
    registry.register({ ...fx.descriptor, custody });
    const conn = await registry.connect("fake-telegram");

    const conferral = registry.confer(conn.connectionKind, conn.id, "bot", fx.validCredential());
    // Let the conferral reach and park inside its lock.
    await flush();
    const revoke = conn.auth.revoke("bot");
    await flush();
    expect(conn.auth.grants().bot).toBe("authorized"); // conferral parked, revoke queued

    release();
    await Promise.all([conferral, revoke]);

    // Later-issued revoke wins: memory and ledger agree on unauthorized, no cred.
    expect(conn.auth.grants().bot).toBe("unauthorized");
    expect(conn.isUnlocked("talk")).toBe(false);
    const rec = await ledger.grantOf(conn.id);
    expect(rec?.state).toBe("unauthorized");
    expect(rec?.credential).toBeUndefined();
  });

  // Acceptance: concurrent conferral + conferral on the same grant — exactly one
  // final authorized grant whose credential, profile, and conferredAt are ONE
  // conferral's complete outcome (the later-issued one), with no field mixing
  // and no split between the ledger row and the live in-memory credential.
  it("two conferrals: the later-issued one's complete outcome wins, no field mixing", async () => {
    const { custody, release } = makeGatedCustody();
    const ledger = makeLedger();
    // Monotonic clock so the two conferrals stamp distinct conferredAt values:
    // connect() takes tick 1 (createdAt); each conferral takes two (a createdAt
    // for a mint, then its conferredAt), so #1 stamps tick 3 and #2 tick 5.
    let tick = 0;
    const registry = new ConnectionRegistry({
      repository: ledger,
      clock: () => new Date(1000 * ++tick),
    });
    const fx = makePasteTalk();
    registry.register({ ...fx.descriptor, custody });
    const conn = await registry.connect("fake-telegram");

    const first = registry.confer(
      conn.connectionKind,
      conn.id,
      "bot",
      { material: { token: "tok1" }, expiresAt: "never" },
      { login: "one" },
    );
    const second = registry.confer(
      conn.connectionKind,
      conn.id,
      "bot",
      { material: { token: "tok2" }, expiresAt: "never" },
      { login: "two" },
    );

    await flush(); // first conferral parks inside its lock
    release();
    await Promise.all([first, second]);

    // The final ledger row is the SECOND conferral's complete triple.
    const rec = await ledger.grantOf(conn.id);
    expect(rec?.state).toBe("authorized");
    expect(rec?.credential?.material).toEqual({ kind: "inline", record: { token: "tok2" } });
    expect(rec?.profile).toEqual({ login: "two" });
    // conferredAt is the later conferral's stamp (tick 5), never mixed with #1's.
    expect((rec?.conferredAt as Date).getTime()).toBe(5000);

    // No split-brain: the live capability was built with the SAME credential the
    // ledger row records (tok2), not the earlier conferral's tok1.
    const latest = fx.talkerFactory.instances.at(-1);
    expect(latest?.state.starts.at(-1)?.cred.material).toEqual({ token: "tok2" });
    expect(conn.auth.grants().bot).toBe("authorized");
  });
});

describe("per-connection lock: independent connections do not serialize", () => {
  // Acceptance: mutations on DIFFERENT Services/connections do not serialize —
  // each ConnectionImpl owns its own per-grant chains.
  it("a parked conferral on one connection does not block another connection's conferral", async () => {
    const fx = makePasteTalk();
    // Gate only connection A's conferral.
    const { custody, release } = makeGatedCustody();
    const registry = new ConnectionRegistry({ repository: makeLedger() });
    registry.register({ ...fx.descriptor, custody });
    registry.register({ ...fx.descriptor, connectionKind: "fake-signal" });
    const connA = await registry.connect("fake-telegram");
    const connB = await registry.connect("fake-signal");

    const aConferral = registry.confer(connA.connectionKind, connA.id, "bot", fx.validCredential());
    const bConferral = registry.confer(connB.connectionKind, connB.id, "bot", fx.validCredential());

    // Connection B's conferral completes while A's is still parked.
    await bConferral;
    expect(connB.auth.grants().bot).toBe("authorized");
    let aSettled = false;
    void aConferral.then(() => {
      aSettled = true;
    });
    await flush();
    expect(aSettled).toBe(false);

    release();
    await aConferral;
    expect(connA.auth.grants().bot).toBe("authorized");
  });
});
