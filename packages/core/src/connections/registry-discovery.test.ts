// Registry discovery contract tests.
//
// Covers spec scenarios: 1 (chat unlocked by its grant), 2 (needs-auth precision),
// 3 (import unlocks + onUnlocked), 4 (every grant is a fresh grant),
// 14 (ledger invariants), 16 (late onUnlocked registration),
// 17 (register validation), 18 (load with unregistered service).
//
// The suite runs against the drizzle-backed ledger (fresh test db per test).

import { NO_GRANT } from "./grant.js";
import { describe, it, expect } from "@rstest/core";
import { sendThrough } from "../channels/connection-ports.js";
import { ConnectionRegistry } from "./registry.js";
import { DrizzleConnectionsRepository } from "./repository-db.js";
import { createTestDb } from "../test/helpers.js";
import type { ChatId } from "@rome-os/app-runtime";
import {
  makePasteTalk,
  makeBotAll,
  makeRenewableAct,
  makeInboundMessage,
  CredentialRejected,
} from "./test-fixtures.js";
import type { ConnectionsRepository } from "./repository.js";
import type { Connection } from "./types.js";

// Ledger factory — a fresh drizzle-backed ledger per test

function makeLedger(): ConnectionsRepository {
  return new DrizzleConnectionsRepository(createTestDb().db);
}

// Helpers

function makeRegistry(ledger: ConnectionsRepository): ConnectionRegistry {
  return new ConnectionRegistry({ repository: ledger });
}

// Scenario 1 — chat unlocked by its grant; onUnlocked fires; talker roundtrip

describe("scenario 1: chat unlocked by its grant", () => {
  it("talk is locked at connect and unlocked once the grant is held", async () => {
    const ledger = makeLedger();
    const reg = makeRegistry(ledger);
    const { descriptor, talkerFactory, validCredential } = makePasteTalk();
    reg.register(descriptor);

    const conn = await reg.connect("fake-telegram");
    expect(conn.isUnlocked("chat")).toBe(false);
    await reg.giveGrant(conn.connectionKind, conn.id, "bot", validCredential());

    expect(conn.isUnlocked("chat")).toBe(true);
    expect(conn.act).toBeNull();
    expect(conn.watch).toBeNull();
    expect(talkerFactory.instances).toHaveLength(1);
  });

  it("status reports unlocked for talk, unsupported for act/watch", async () => {
    const ledger = makeLedger();
    const reg = makeRegistry(ledger);
    const { descriptor, validCredential } = makePasteTalk();
    reg.register(descriptor);

    const conn = await reg.connect("fake-telegram");
    await reg.giveGrant(conn.connectionKind, conn.id, "bot", validCredential());
    const s = conn.status();

    expect(s.chat).toEqual({ state: "unlocked" });
    expect(s.act).toEqual({ state: "unsupported" });
    expect(s.watch).toEqual({ state: "unsupported" });
  });

  it("onUnlocked fires when registered before connect", async () => {
    const ledger = makeLedger();
    const reg = makeRegistry(ledger);
    const { descriptor, validCredential } = makePasteTalk();
    reg.register(descriptor);

    const fired: Connection[] = [];
    reg.onUnlocked("chat", (c) => fired.push(c));

    const conn = await reg.connect("fake-telegram");
    await reg.giveGrant(conn.connectionKind, conn.id, "bot", validCredential());

    expect(fired).toHaveLength(1);
    expect(fired[0].id).toBe(conn.id);
  });

  it("deliver→handler roundtrip: message delivered via onMessage reaches the handler", async () => {
    const ledger = makeLedger();
    const reg = makeRegistry(ledger);
    const { descriptor, talkerFactory, validCredential } = makePasteTalk();
    reg.register(descriptor);

    const conn = await reg.connect("fake-telegram");
    await reg.giveGrant(conn.connectionKind, conn.id, "bot", validCredential());
    const received: unknown[] = [];
    conn.hearTalker(async (msg) => {
      received.push(msg);
    });

    const msg = makeInboundMessage({ text: "hello" });
    talkerFactory.instances[0].state.deliver!(msg);

    expect(received).toHaveLength(1);
    expect(received[0]).toBe(msg);
  });

  it("send() is recorded on the fake talker", async () => {
    const ledger = makeLedger();
    const reg = makeRegistry(ledger);
    const { descriptor, talkerFactory, validCredential } = makePasteTalk();
    reg.register(descriptor);

    const conn = await reg.connect("fake-telegram");
    await reg.giveGrant(conn.connectionKind, conn.id, "bot", validCredential());
    await sendThrough(conn, "thread-1" as ChatId, { text: "reply" });

    expect(talkerFactory.instances[0].state.sends).toHaveLength(1);
    expect(talkerFactory.instances[0].state.sends[0].address).toBe("thread-1");
  });
});

// Scenario 2 — needs-auth precision: botAll with nothing granted

describe("scenario 2: needs-auth precision", () => {
  it("talk status reports needs-auth with [bot] before any grant", async () => {
    const ledger = makeLedger();
    const reg = makeRegistry(ledger);
    const { descriptor } = makeBotAll();
    reg.register(descriptor);

    const conn = await reg.connect("fake-discord");
    const s = conn.status();

    expect(s.chat).toEqual({ state: "needs-auth", missingGrants: ["bot"] });
  });

  it("watch status reports needs-auth with [bot] before any grant", async () => {
    const ledger = makeLedger();
    const reg = makeRegistry(ledger);
    const { descriptor } = makeBotAll();
    reg.register(descriptor);

    const conn = await reg.connect("fake-discord");
    const s = conn.status();

    expect(s.watch).toEqual({ state: "needs-auth", missingGrants: ["bot"] });
  });

  it("act status reports needs-auth with [bot] before any grant", async () => {
    const ledger = makeLedger();
    const reg = makeRegistry(ledger);
    const { descriptor } = makeBotAll();
    reg.register(descriptor);

    const conn = await reg.connect("fake-discord");
    const s = conn.status();

    expect(s.act).toEqual({ state: "needs-auth", missingGrants: ["bot"] });
  });

  it("after bot import: talk, watch and act are unlocked", async () => {
    const ledger = makeLedger();
    const reg = makeRegistry(ledger);
    const { descriptor, botCredential } = makeBotAll();
    reg.register(descriptor);

    const conn = await reg.connect("fake-discord");
    await reg.giveGrant(conn.connectionKind, conn.id, "bot", botCredential());

    const s = conn.status();

    expect(s.chat).toEqual({ state: "unlocked" });
    expect(s.watch).toEqual({ state: "unlocked" });
    expect(s.act).toEqual({ state: "unlocked" });
  });

  it("talk, watch and act handles are non-null after bot import", async () => {
    const ledger = makeLedger();
    const reg = makeRegistry(ledger);
    const { descriptor, botCredential } = makeBotAll();
    reg.register(descriptor);

    const conn = await reg.connect("fake-discord");
    await reg.giveGrant(conn.connectionKind, conn.id, "bot", botCredential());

    expect(conn.isUnlocked("chat")).toBe(true);
    expect(conn.watch).not.toBeNull();
    expect(conn.act).not.toBeNull();
  });
});

// Scenario 3 — authorize via grant unlocks + fires onUnlocked once per cap

describe("scenario 3: import unlocks + fires onUnlocked", () => {
  it("grant transitions grants() to authorized", async () => {
    const ledger = makeLedger();
    const reg = makeRegistry(ledger);
    const { descriptor, botCredential } = makeBotAll();
    reg.register(descriptor);

    const conn = await reg.connect("fake-discord");
    expect(conn.auth.grants()["bot"]).toBe("unauthorized");

    await reg.giveGrant(conn.connectionKind, conn.id, "bot", botCredential());

    expect(conn.auth.grants()["bot"]).toBe("authorized");
  });

  it("onUnlocked fires for talk and watch after bot import", async () => {
    const ledger = makeLedger();
    const reg = makeRegistry(ledger);
    const { descriptor, botCredential } = makeBotAll();
    reg.register(descriptor);

    const talkFired: Connection[] = [];
    const watchFired: Connection[] = [];
    reg.onUnlocked("chat", (c) => talkFired.push(c));
    reg.onUnlocked("watch", (c) => watchFired.push(c));

    const conn = await reg.connect("fake-discord");
    await reg.giveGrant(conn.connectionKind, conn.id, "bot", botCredential());

    expect(talkFired).toHaveLength(1);
    expect(talkFired[0].id).toBe(conn.id);
    expect(watchFired).toHaveLength(1);
    expect(watchFired[0].id).toBe(conn.id);
  });

  it("onUnlocked fires ONCE per cap (not twice) for a single import", async () => {
    const ledger = makeLedger();
    const reg = makeRegistry(ledger);
    const { descriptor, botCredential } = makeBotAll();
    reg.register(descriptor);

    let count = 0;
    reg.onUnlocked("chat", () => count++);

    const conn = await reg.connect("fake-discord");
    await reg.giveGrant(conn.connectionKind, conn.id, "bot", botCredential());

    expect(count).toBe(1);
  });
});

// Scenario 4 — every grant is a fresh grant: even the same material rebuilds

describe("scenario 4: every grant is a fresh grant", () => {
  it("a grant rebuilds the epoch", async () => {
    const ledger = makeLedger();
    const reg = makeRegistry(ledger);
    const { descriptor, botCredential, talkerFactory } = makeBotAll();
    reg.register(descriptor);

    const conn = await reg.connect("fake-discord");
    await reg.giveGrant(conn.connectionKind, conn.id, "bot", botCredential());

    const firstInstance = talkerFactory.instances[0];

    // Import a credential with different material.
    await reg.giveGrant(conn.connectionKind, conn.id, "bot", {
      material: { token: "different-token" },
      expiresAt: "never",
    });

    // Old instance stopped, new one built.
    expect(firstInstance.state.stopCount).toBe(1);
    expect(talkerFactory.instances).toHaveLength(2);
  });

  it("fixing the same material activates a capability whose build failed", async () => {
    const reg = makeRegistry(makeLedger());
    const fx = makePasteTalk();
    const talker = fx.descriptor.capabilities.talker!;
    let failNext = true;
    reg.register({
      ...fx.descriptor,
      capabilities: {
        ...fx.descriptor.capabilities,
        talker: {
          ...talker,
          build(...args: Parameters<typeof talker.build>) {
            if (failNext) {
              failNext = false;
              throw new Error("build failed");
            }
            return talker.build(...args);
          },
        },
      },
    });
    const conn = await reg.connect("fake-telegram");

    await reg.giveGrant(conn.connectionKind, conn.id, "bot", fx.validCredential());
    expect(conn.isUnlocked("chat")).toBe(false);
    await reg.giveGrant(conn.connectionKind, conn.id, "bot", fx.validCredential());

    expect(conn.isUnlocked("chat")).toBe(true);
  });

  it("fixing same material with a later expiry keeps the grant from renewing early", async () => {
    const now = new Date("2026-10-26T00:00:00Z");
    const reg = new ConnectionRegistry({ repository: makeLedger(), clock: () => now });
    const { descriptor, userScheme } = makeRenewableAct();
    reg.register(descriptor);
    const conn = await reg.connect("fake-github");
    const material = { token: "same-token" };

    await reg.giveGrant(conn.connectionKind, conn.id, "user", {
      material,
      expiresAt: new Date(now.getTime() + 60_000),
    });
    await reg.giveGrant(conn.connectionKind, conn.id, "user", {
      material: { ...material },
      expiresAt: new Date(now.getTime() + 10 * 24 * 60 * 60_000),
    });
    await reg.renewExpiring(60 * 60_000);

    // The live credential took the later expiry, so nothing was due to renew.
    expect(userScheme.materialHistory).toEqual([]);
  });
});

// Scenario 14 — ledger invariants

describe("scenario 14: ledger invariants", () => {
  it("the grant row exists in unauthorized state immediately after connect (before any grant)", async () => {
    const ledger = makeLedger();
    const reg = makeRegistry(ledger);
    const { descriptor } = makeBotAll();
    reg.register(descriptor);

    const conn = await reg.connect("fake-discord");

    const botRow = await ledger.grantOf(conn.id);

    expect(botRow).not.toBeNull();
    expect(botRow!.state).toBe("unauthorized");
  });

  it("credential is absent (undefined) when grant is unauthorized", async () => {
    const ledger = makeLedger();
    const reg = makeRegistry(ledger);
    const { descriptor } = makeBotAll();
    reg.register(descriptor);

    const conn = await reg.connect("fake-discord");

    const botRow = await ledger.grantOf(conn.id);
    expect(botRow!.credential).toBeUndefined();
  });

  it("credential is present after import (state authorized)", async () => {
    const ledger = makeLedger();
    const reg = makeRegistry(ledger);
    const { descriptor, botCredential } = makeBotAll();
    reg.register(descriptor);

    const conn = await reg.connect("fake-discord");
    await reg.giveGrant(conn.connectionKind, conn.id, "bot", botCredential());

    const botRow = await ledger.grantOf(conn.id);
    expect(botRow!.state).toBe("authorized");
    expect(botRow!.credential).toBeDefined();
  });

  it("deleteConnection cascades connection-scoped grants", async () => {
    const ledger = makeLedger();
    const reg = makeRegistry(ledger);
    const { descriptor } = makeBotAll();
    reg.register(descriptor);

    const conn = await reg.connect("fake-discord");

    // Verify grant rows exist first.
    expect(await ledger.grantOf(conn.id)).not.toBeNull();

    await reg.remove(conn.id);

    // Grant row must be gone after deletion.
    const afterBot = await ledger.grantOf(conn.id);
    expect(afterBot).toBeNull();
  });
});

// Scenario 16 — late onUnlocked registration

describe("scenario 16: late onUnlocked registration", () => {
  it("onUnlocked fires immediately for already-unlocked connections when registered late", async () => {
    const ledger = makeLedger();
    const reg = makeRegistry(ledger);
    const { descriptor, validCredential } = makePasteTalk();
    reg.register(descriptor);

    // Connect and give access first, so talk is unlocked.
    const conn = await reg.connect("fake-telegram");
    await reg.giveGrant(conn.connectionKind, conn.id, "bot", validCredential());

    // Register the handler AFTER the connection is already unlocked.
    const fired: Connection[] = [];
    reg.onUnlocked("chat", (c) => fired.push(c));

    // Handler must fire immediately for the already-unlocked connection.
    expect(fired).toHaveLength(1);
    expect(fired[0].id).toBe(conn.id);
  });

  it("onUnlocked fires immediately for multiple already-unlocked connections", async () => {
    const ledger = makeLedger();
    const reg = makeRegistry(ledger);
    const { descriptor, validCredential } = makePasteTalk();
    reg.register(descriptor);
    reg.register({ ...descriptor, connectionKind: "fake-signal" });

    const connA = await reg.connect("fake-telegram");
    const connB = await reg.connect("fake-signal");
    await reg.giveGrant(connA.connectionKind, connA.id, "bot", validCredential());
    await reg.giveGrant(connB.connectionKind, connB.id, "bot", validCredential());

    const fired: Connection[] = [];
    reg.onUnlocked("chat", (c) => fired.push(c));

    expect(fired).toHaveLength(2);
    const ids = fired.map((c) => c.id);
    expect(ids).toContain(connA.id);
    expect(ids).toContain(connB.id);
  });

  it("onUnlocked fires only for unlocked (not locked) connections when registered late", async () => {
    const ledger = makeLedger();
    const reg = makeRegistry(ledger);
    const { descriptor } = makePasteTalk();
    reg.register(descriptor);

    // Connect without importing a credential → locked.
    await reg.connect("fake-telegram");

    const fired: Connection[] = [];
    reg.onUnlocked("chat", (c) => fired.push(c));

    // No fire because the connection is locked (needs-auth).
    expect(fired).toHaveLength(0);
  });
});

// Scenario 17 — register() validation

describe("scenario 17: register() validation", () => {
  it("throws on duplicate service name", async () => {
    const ledger = makeLedger();
    const reg = makeRegistry(ledger);
    const { descriptor } = makePasteTalk();
    reg.register(descriptor);

    expect(() => reg.register(descriptor)).toThrow(/duplicate/i);
  });
});

// Scenario 18 — load() with rows for an unregistered service

describe("scenario 18: load() with unregistered service rows", () => {
  it("load() skips unknown services without throwing", async () => {
    const ledger = makeLedger();

    // Manually insert a connection for a service that won't be registered.
    ledger.transaction((tx) =>
      ledger.save(tx, {
        id: "orphan-conn-1",
        connectionKind: "ghost-service",
        label: "ghost",
        createdAt: new Date(),
        grant: NO_GRANT,
      }),
    );

    const reg = makeRegistry(ledger);
    // Register a DIFFERENT service, not "ghost-service".
    const { descriptor } = makePasteTalk();
    reg.register(descriptor);

    // load() must not throw, even though "ghost-service" has no descriptor.
    await expect(reg.load()).resolves.toBeUndefined();
  });

  it("load() still loads known-service connections when unknown ones exist alongside them", async () => {
    const ledger = makeLedger();

    // Insert an orphan.
    ledger.transaction((tx) =>
      ledger.save(tx, {
        id: "orphan-conn-2",
        connectionKind: "ghost-service-2",
        label: "ghost2",
        createdAt: new Date(),
        grant: NO_GRANT,
      }),
    );

    const reg = makeRegistry(ledger);
    const { descriptor, validCredential } = makePasteTalk();
    reg.register(descriptor);

    // Also mint a real connection through the registry (goes through ledger).
    const conn = await reg.connect("fake-telegram");
    await reg.giveGrant(conn.connectionKind, conn.id, "bot", validCredential());
    expect(conn.isUnlocked("chat")).toBe(true);

    // Create a new registry over the same ledger and load.
    const reg2 = makeRegistry(ledger);
    reg2.register({ ...descriptor });

    await reg2.load();

    const loaded = reg2.find("fake-telegram");
    expect(loaded).toHaveLength(1);
    expect(loaded[0].id).toBe(conn.id);
    expect(loaded[0].isUnlocked("chat")).toBe(true);
  });

  it("all() does not include orphaned unknown-service connections after load", async () => {
    const ledger = makeLedger();

    ledger.transaction((tx) =>
      ledger.save(tx, {
        id: "orphan-conn-3",
        connectionKind: "totally-unknown",
        label: "unknown",
        createdAt: new Date(),
        grant: NO_GRANT,
      }),
    );

    const reg = makeRegistry(ledger);
    await reg.load();

    const all = reg.all();
    const orphan = all.find((c) => c.id === "orphan-conn-3");
    expect(orphan).toBeUndefined();
  });
});

describe("startup capability activation barrier", () => {
  it("hydrates connections without starting Talk until the cutover releases the barrier", async () => {
    const ledger = makeLedger();
    const first = makePasteTalk();
    const before = makeRegistry(ledger);
    before.register(first.descriptor);
    const { id } = await before.connect("fake-telegram", "Telegram");
    await before.giveGrant("fake-telegram", id, "bot", first.validCredential());

    const reg = makeRegistry(ledger);
    const { descriptor, talkerFactory } = makePasteTalk();
    reg.register(descriptor);
    const unlocked: Connection[] = [];
    reg.onUnlocked("chat", (connection) => unlocked.push(connection));

    await reg.load({ deferCapabilities: true });

    expect(reg.get(id).isUnlocked("chat")).toBe(false);
    expect(talkerFactory.instances).toHaveLength(0);
    expect(unlocked).toHaveLength(0);

    reg.startCapabilities();

    expect(reg.get(id).isUnlocked("chat")).toBe(true);
    expect(talkerFactory.instances).toHaveLength(1);
    expect(unlocked).toEqual([reg.get(id)]);
  });
});

// Extra: CredentialRejected import to verify the error class is usable

describe("CredentialRejected shape sanity", () => {
  it("can be constructed and is an Error", () => {
    const err = new CredentialRejected({ grant: "bot", cause: new Error("x") });
    expect(err).toBeInstanceOf(Error);
    expect(err.grant).toBe("bot");
  });
});
