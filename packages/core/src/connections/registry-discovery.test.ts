// Registry discovery contract tests.
//
// Covers spec scenarios: 1 (zero-grant), 2 (needs-auth precision),
// 3 (import unlocks + onUnlocked), 4 (idempotent import),
// 14 (ledger invariants), 16 (late onUnlocked registration),
// 17 (register validation), 18 (load with unregistered service).
//
// The suite runs against the drizzle-backed ledger (fresh test db per test).

import { describe, it, expect } from "@rstest/core";
import { ConnectionRegistry } from "./registry.js";
import { DrizzleGrantLedger } from "./ledger-db.js";
import { createTestDb } from "../test/helpers.js";
import type { ConversationId } from "@rome-os/app-runtime";
import {
  makeZeroGrantTalk,
  makePasteTalk,
  makeTwoGrant,
  makeInboundMessage,
  CredentialRejected,
} from "./test-fixtures.js";
import type { GrantLedger } from "./ledger.js";
import type { Connection } from "./types.js";

// Ledger factory — a fresh drizzle-backed ledger per test

function makeLedger(): GrantLedger {
  return new DrizzleGrantLedger(createTestDb().db);
}

// Helpers

function makeRegistry(ledger: GrantLedger): ConnectionRegistry {
  return new ConnectionRegistry({ ledger });
}

// Scenario 1 — zero-grant: unlocked at connect; onUnlocked fires; talk roundtrip

describe("scenario 1: zero-grant talk", () => {
  it("talk is non-null immediately after connect", async () => {
    const ledger = makeLedger();
    const reg = makeRegistry(ledger);
    const { descriptor, talkerFactory } = makeZeroGrantTalk();
    reg.register(descriptor);

    const conn = await reg.connect("fake-webchat");

    // Zero-grant capability must be unlocked at birth.
    expect(conn.talk).not.toBeNull();
    expect(conn.act).toBeNull();
    expect(conn.watch).toBeNull();
    expect(talkerFactory.instances).toHaveLength(1);
  });

  it("status reports unlocked for talk, unsupported for act/watch", async () => {
    const ledger = makeLedger();
    const reg = makeRegistry(ledger);
    const { descriptor } = makeZeroGrantTalk();
    reg.register(descriptor);

    const conn = await reg.connect("fake-webchat");
    const s = conn.status();

    expect(s.talk).toEqual({ state: "unlocked" });
    expect(s.act).toEqual({ state: "unsupported" });
    expect(s.watch).toEqual({ state: "unsupported" });
  });

  it("onUnlocked fires synchronously when registered before connect", async () => {
    const ledger = makeLedger();
    const reg = makeRegistry(ledger);
    const { descriptor } = makeZeroGrantTalk();
    reg.register(descriptor);

    const fired: Connection[] = [];
    reg.onUnlocked("talk", (c) => fired.push(c));

    const conn = await reg.connect("fake-webchat");

    expect(fired).toHaveLength(1);
    expect(fired[0].id).toBe(conn.id);
  });

  it("deliver→handler roundtrip: message delivered via onMessage reaches the handler", async () => {
    const ledger = makeLedger();
    const reg = makeRegistry(ledger);
    const { descriptor, talkerFactory } = makeZeroGrantTalk();
    reg.register(descriptor);

    const conn = await reg.connect("fake-webchat");
    const talk = conn.talk!;

    const received: unknown[] = [];
    talk.subscribe(async (msg) => {
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
    const { descriptor, talkerFactory } = makeZeroGrantTalk();
    reg.register(descriptor);

    const conn = await reg.connect("fake-webchat");
    await conn.talk!.send("thread-1" as ConversationId, { text: "reply" });

    expect(talkerFactory.instances[0].state.sends).toHaveLength(1);
    expect(talkerFactory.instances[0].state.sends[0].address).toBe("thread-1");
  });
});

// Scenario 2 — needs-auth precision: twoGrant with nothing conferred

describe("scenario 2: needs-auth precision", () => {
  it("talk status reports needs-auth with [bot] before any confer", async () => {
    const ledger = makeLedger();
    const reg = makeRegistry(ledger);
    const { descriptor } = makeTwoGrant();
    reg.register(descriptor);

    const conn = await reg.connect("fake-discord");
    const s = conn.status();

    expect(s.talk).toEqual({ state: "needs-auth", missingGrants: ["bot"] });
  });

  it("watch status reports needs-auth with [bot] before any confer", async () => {
    const ledger = makeLedger();
    const reg = makeRegistry(ledger);
    const { descriptor } = makeTwoGrant();
    reg.register(descriptor);

    const conn = await reg.connect("fake-discord");
    const s = conn.status();

    expect(s.watch).toEqual({ state: "needs-auth", missingGrants: ["bot"] });
  });

  it("act status reports needs-auth with [user] before any confer", async () => {
    const ledger = makeLedger();
    const reg = makeRegistry(ledger);
    const { descriptor } = makeTwoGrant();
    reg.register(descriptor);

    const conn = await reg.connect("fake-discord");
    const s = conn.status();

    expect(s.act).toEqual({ state: "needs-auth", missingGrants: ["user"] });
  });

  it("after bot import: talk+watch unlocked, act still needs-auth [user]", async () => {
    const ledger = makeLedger();
    const reg = makeRegistry(ledger);
    const { descriptor, botCredential } = makeTwoGrant();
    reg.register(descriptor);

    const conn = await reg.connect("fake-discord");
    await reg.importCredential(conn.id, "bot", botCredential());

    const s = conn.status();

    expect(s.talk).toEqual({ state: "unlocked" });
    expect(s.watch).toEqual({ state: "unlocked" });
    expect(s.act).toEqual({ state: "needs-auth", missingGrants: ["user"] });
  });

  it("talk and watch handles are non-null after bot import; act is still null", async () => {
    const ledger = makeLedger();
    const reg = makeRegistry(ledger);
    const { descriptor, botCredential } = makeTwoGrant();
    reg.register(descriptor);

    const conn = await reg.connect("fake-discord");
    await reg.importCredential(conn.id, "bot", botCredential());

    expect(conn.talk).not.toBeNull();
    expect(conn.watch).not.toBeNull();
    expect(conn.act).toBeNull();
  });
});

// Scenario 3 — authorize via importCredential unlocks + fires onUnlocked once per cap

describe("scenario 3: import unlocks + fires onUnlocked", () => {
  it("importCredential transitions grants() to authorized", async () => {
    const ledger = makeLedger();
    const reg = makeRegistry(ledger);
    const { descriptor, botCredential } = makeTwoGrant();
    reg.register(descriptor);

    const conn = await reg.connect("fake-discord");
    expect(conn.auth.grants()["bot"]).toBe("unauthorized");

    await reg.importCredential(conn.id, "bot", botCredential());

    expect(conn.auth.grants()["bot"]).toBe("authorized");
  });

  it("onUnlocked fires for talk and watch after bot import", async () => {
    const ledger = makeLedger();
    const reg = makeRegistry(ledger);
    const { descriptor, botCredential } = makeTwoGrant();
    reg.register(descriptor);

    const talkFired: Connection[] = [];
    const watchFired: Connection[] = [];
    reg.onUnlocked("talk", (c) => talkFired.push(c));
    reg.onUnlocked("watch", (c) => watchFired.push(c));

    const conn = await reg.connect("fake-discord");
    await reg.importCredential(conn.id, "bot", botCredential());

    expect(talkFired).toHaveLength(1);
    expect(talkFired[0].id).toBe(conn.id);
    expect(watchFired).toHaveLength(1);
    expect(watchFired[0].id).toBe(conn.id);
  });

  it("onUnlocked fires ONCE per cap (not twice) for a single import", async () => {
    const ledger = makeLedger();
    const reg = makeRegistry(ledger);
    const { descriptor, botCredential } = makeTwoGrant();
    reg.register(descriptor);

    let count = 0;
    reg.onUnlocked("talk", () => count++);

    const conn = await reg.connect("fake-discord");
    await reg.importCredential(conn.id, "bot", botCredential());

    expect(count).toBe(1);
  });
});

// Scenario 4 — idempotent import: same material → no new epoch, no re-fire

describe("scenario 4: idempotent import", () => {
  it("re-importing same material does not call stop() on the talker", async () => {
    const ledger = makeLedger();
    const reg = makeRegistry(ledger);
    const { descriptor, botCredential, talkerFactory } = makeTwoGrant();
    reg.register(descriptor);

    const conn = await reg.connect("fake-discord");
    const cred = botCredential();
    await reg.importCredential(conn.id, "bot", cred);

    const firstInstance = talkerFactory.instances[0];
    expect(firstInstance.state.stopCount).toBe(0);

    // Re-import identical material.
    await reg.importCredential(conn.id, "bot", { ...cred });

    // No new stop() call, same instance count.
    expect(firstInstance.state.stopCount).toBe(0);
    expect(talkerFactory.instances).toHaveLength(1);
  });

  it("re-importing same material does not re-fire onUnlocked", async () => {
    const ledger = makeLedger();
    const reg = makeRegistry(ledger);
    const { descriptor, botCredential } = makeTwoGrant();
    reg.register(descriptor);

    let count = 0;
    reg.onUnlocked("talk", () => count++);

    const conn = await reg.connect("fake-discord");
    const cred = botCredential();
    await reg.importCredential(conn.id, "bot", cred);
    expect(count).toBe(1);

    // Re-import identical material.
    await reg.importCredential(conn.id, "bot", { ...cred });

    // Still exactly 1.
    expect(count).toBe(1);
  });

  it("importing different material DOES trigger a new epoch", async () => {
    const ledger = makeLedger();
    const reg = makeRegistry(ledger);
    const { descriptor, botCredential, talkerFactory } = makeTwoGrant();
    reg.register(descriptor);

    const conn = await reg.connect("fake-discord");
    await reg.importCredential(conn.id, "bot", botCredential());

    const firstInstance = talkerFactory.instances[0];

    // Import a credential with different material.
    await reg.importCredential(conn.id, "bot", {
      material: { token: "different-token" },
      expiresAt: "never",
    });

    // Old instance stopped, new one built.
    expect(firstInstance.state.stopCount).toBe(1);
    expect(talkerFactory.instances).toHaveLength(2);
  });
});

// Scenario 14 — ledger invariants

describe("scenario 14: ledger invariants", () => {
  it("grant rows exist in unauthorized state immediately after connect (before any confer)", async () => {
    const ledger = makeLedger();
    const reg = makeRegistry(ledger);
    const { descriptor } = makeTwoGrant();
    reg.register(descriptor);

    const conn = await reg.connect("fake-discord");

    // Both grants must exist immediately after connect.
    const botRow = await ledger.getGrant(conn.id, "bot");
    const userRow = await ledger.getGrant(conn.id, "user");

    expect(botRow).not.toBeNull();
    expect(botRow!.state).toBe("unauthorized");
    expect(userRow).not.toBeNull();
    expect(userRow!.state).toBe("unauthorized");
  });

  it("credential is absent (undefined) when grant is unauthorized", async () => {
    const ledger = makeLedger();
    const reg = makeRegistry(ledger);
    const { descriptor } = makeTwoGrant();
    reg.register(descriptor);

    const conn = await reg.connect("fake-discord");

    const botRow = await ledger.getGrant(conn.id, "bot");
    expect(botRow!.credential).toBeUndefined();
  });

  it("credential is present after import (state authorized)", async () => {
    const ledger = makeLedger();
    const reg = makeRegistry(ledger);
    const { descriptor, botCredential } = makeTwoGrant();
    reg.register(descriptor);

    const conn = await reg.connect("fake-discord");
    await reg.importCredential(conn.id, "bot", botCredential());

    const botRow = await ledger.getGrant(conn.id, "bot");
    expect(botRow!.state).toBe("authorized");
    expect(botRow!.credential).toBeDefined();
  });

  it("deleteConnection cascades connection-scoped grants", async () => {
    const ledger = makeLedger();
    const reg = makeRegistry(ledger);
    const { descriptor } = makeTwoGrant();
    reg.register(descriptor);

    const conn = await reg.connect("fake-discord");

    // Verify grant rows exist first.
    expect(await ledger.getGrant(conn.id, "bot")).not.toBeNull();

    await reg.remove(conn.id);

    // Grant row must be gone after deletion.
    const afterBot = await ledger.getGrant(conn.id, "bot");
    expect(afterBot).toBeNull();
  });
});

// Scenario 16 — late onUnlocked registration

describe("scenario 16: late onUnlocked registration", () => {
  it("onUnlocked fires immediately for already-unlocked connections when registered late", async () => {
    const ledger = makeLedger();
    const reg = makeRegistry(ledger);
    const { descriptor } = makeZeroGrantTalk();
    reg.register(descriptor);

    // Connect first (zero-grant → immediately unlocked).
    const conn = await reg.connect("fake-webchat");

    // Register the handler AFTER the connection is already unlocked.
    const fired: Connection[] = [];
    reg.onUnlocked("talk", (c) => fired.push(c));

    // Handler must fire immediately for the already-unlocked connection.
    expect(fired).toHaveLength(1);
    expect(fired[0].id).toBe(conn.id);
  });

  it("onUnlocked fires immediately for multiple already-unlocked connections", async () => {
    const ledger = makeLedger();
    const reg = makeRegistry(ledger);
    const { descriptor } = makeZeroGrantTalk();
    reg.register(descriptor);
    reg.register({ ...descriptor, service: "fake-browser-chat" });

    const connA = await reg.connect("fake-webchat");
    const connB = await reg.connect("fake-browser-chat");

    const fired: Connection[] = [];
    reg.onUnlocked("talk", (c) => fired.push(c));

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
    reg.onUnlocked("talk", (c) => fired.push(c));

    // No fire because the connection is locked (needs-auth).
    expect(fired).toHaveLength(0);
  });
});

// Scenario 17 — register() validation

describe("scenario 17: register() validation", () => {
  it("throws on duplicate service name", async () => {
    const ledger = makeLedger();
    const reg = makeRegistry(ledger);
    const { descriptor } = makeZeroGrantTalk();
    reg.register(descriptor);

    expect(() => reg.register(descriptor)).toThrow(/duplicate/i);
  });

  it("throws when capability needs a grant not in auth", () => {
    const ledger = makeLedger();
    const reg = makeRegistry(ledger);

    expect(() =>
      reg.register({
        service: "bad-service",
        auth: {},
        capabilities: {
          actor: {
            needs: ["user" as const],
            build: () => ({
              operations: () => [],
              async invoke() {
                return null;
              },
            }),
          },
        },
      }),
    ).toThrow(/undeclared grant/i);
  });

  it("throws when talker needs an undeclared grant", () => {
    const ledger = makeLedger();
    const reg = makeRegistry(ledger);

    expect(() =>
      reg.register({
        service: "bad-talk",
        auth: {},
        capabilities: {
          talker: {
            needs: ["bot" as const],
            build: () => ({
              start() {},
              stop() {},
              async send(conversationId) {
                return { conversationId };
              },
              feature: () => null,
            }),
          },
        },
      }),
    ).toThrow(/undeclared grant/i);
  });

  it("allows registration of a descriptor with empty needs (valid)", () => {
    const ledger = makeLedger();
    const reg = makeRegistry(ledger);

    expect(() =>
      reg.register({
        service: "valid-service",
        auth: {},
        capabilities: {
          actor: {
            needs: [] as const,
            build: () => ({
              operations: () => [],
              async invoke() {
                return null;
              },
            }),
          },
        },
      }),
    ).not.toThrow();
  });
});

// Scenario 18 — load() with rows for an unregistered service

describe("scenario 18: load() with unregistered service rows", () => {
  it("load() skips unknown services without throwing", async () => {
    const ledger = makeLedger();

    // Manually insert a connection for a service that won't be registered.
    await ledger.createConnection({
      id: "orphan-conn-1",
      service: "ghost-service",
      label: "ghost",
      createdAt: new Date(),
    });

    const reg = makeRegistry(ledger);
    // Register a DIFFERENT service, not "ghost-service".
    const { descriptor } = makeZeroGrantTalk();
    reg.register(descriptor);

    // load() must not throw, even though "ghost-service" has no descriptor.
    await expect(reg.load()).resolves.toBeUndefined();
  });

  it("load() still loads known-service connections when unknown ones exist alongside them", async () => {
    const ledger = makeLedger();

    // Insert an orphan.
    await ledger.createConnection({
      id: "orphan-conn-2",
      service: "ghost-service-2",
      label: "ghost2",
      createdAt: new Date(),
    });

    const reg = makeRegistry(ledger);
    const { descriptor } = makeZeroGrantTalk();
    reg.register(descriptor);

    // Also mint a real connection through the registry (goes through ledger).
    const conn = await reg.connect("fake-webchat");
    expect(conn.talk).not.toBeNull();

    // Create a new registry over the same ledger and load.
    const reg2 = makeRegistry(ledger);
    reg2.register({ ...descriptor });

    await reg2.load();

    const loaded = reg2.find("fake-webchat");
    expect(loaded).toHaveLength(1);
    expect(loaded[0].id).toBe(conn.id);
    expect(loaded[0].talk).not.toBeNull();
  });

  it("all() does not include orphaned unknown-service connections after load", async () => {
    const ledger = makeLedger();

    await ledger.createConnection({
      id: "orphan-conn-3",
      service: "totally-unknown",
      label: "unknown",
      createdAt: new Date(),
    });

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
    await ledger.createConnection({
      id: "boot-webchat",
      service: "fake-webchat",
      label: "Webchat",
      createdAt: new Date(),
    });
    const reg = makeRegistry(ledger);
    const { descriptor, talkerFactory } = makeZeroGrantTalk();
    reg.register(descriptor);
    const unlocked: Connection[] = [];
    reg.onUnlocked("talk", (connection) => unlocked.push(connection));

    await reg.load({ deferCapabilities: true });

    expect(reg.get("boot-webchat").talk).toBeNull();
    expect(talkerFactory.instances).toHaveLength(0);
    expect(unlocked).toHaveLength(0);

    reg.startCapabilities();

    expect(reg.get("boot-webchat").talk).not.toBeNull();
    expect(talkerFactory.instances).toHaveLength(1);
    expect(unlocked).toEqual([reg.get("boot-webchat")]);
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
