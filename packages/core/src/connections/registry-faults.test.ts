// Fault-handling contract suite. The subtlest semantics:
// degrade relocking only dependents (scenario 5), renew-once-then-degrade
// (scenario 6), re-authorize clearing the renewed flag (scenario 7), epoch
// handle death + fresh talker (scenario 8), stop-before-build ordering
// (scenario 9), and Disconnected backoff (scenario 10).
//
// Fault handling in the registry is asynchronous: the registry triggers the flow
// with `void this.handle…` then rethrows the original error to the caller. Tests
// therefore push the fault, then `await flush()` (a macrotask) so the renewal /
// backoff flow settles before asserting.

import { describe, expect, it } from "@rstest/core";
import { createTestDb } from "../test/helpers.js";
import type { DrizzleTx, SqliteExec } from "../db/index.js";
import type { ChannelMessage, ChatId } from "@rome-os/app-runtime";
import { DrizzleConnectionsRepository } from "./repository-db.js";
import type { GrantValue } from "./grant.js";
import type { ConnectionsRepository, StoredConnection } from "./repository.js";
import { ConnectionRegistry } from "./registry.js";
import type {
  Act,
  Connection,
  ConnectionDescriptor,
  ConnectionId,
  Credential,
  GrantName,
} from "./types.js";
import {
  CredentialRejected,
  Disconnected,
  makeFakeTalkerFactory,
  makeInboundMessage,
  makeRecordingSleep,
  makeRenewableAct,
  makePasteTalk,
  makeBotAll,
} from "./test-fixtures.js";

// A macrotask flush: lets the async `void handle…` fault flows (which chain
// awaits over the ledger + reconcile) settle before assertions run.
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// A fresh drizzle-backed ledger per test.
function makeLedger(): ConnectionsRepository {
  return new DrizzleConnectionsRepository(createTestDb().db);
}

/** A ledger whose grant writes throw (a transient DB error) whenever
 *  `shouldFail` matches the grant the write would leave. Every grant write,
 *  a grant's and an update's alike, goes through `save`. */
function makeFailingLedger(shouldFail: (grant: GrantValue) => boolean): ConnectionsRepository {
  class FailingLedger extends DrizzleConnectionsRepository {
    override save(exec: SqliteExec, connection: StoredConnection) {
      if (shouldFail(connection.grant)) throw new Error("LEDGER_WRITE_FAILED");
      super.save(exec, connection);
    }
  }
  return new FailingLedger(createTestDb().db);
}

describe("registry faults", () => {
  // Scenario 5 — a degraded grant relocks every capability
  describe("scenario 5: a degraded grant relocks every capability", () => {
    it("a rejection on act degrades the one grant and relocks talk and watch with it", async () => {
      const ledger = makeLedger();
      const heard: string[] = [];
      const registry = new ConnectionRegistry({
        repository: ledger,
        onEvent: (_tx, event) => heard.push(event.kind),
      });
      const fx = makeBotAll();
      registry.register(fx.descriptor);
      const conn = await registry.connect("fake-discord");
      await registry.giveGrant(conn.connectionKind, conn.id, "bot", fx.botCredential());

      expect(conn.act).not.toBeNull();
      expect(conn.isUnlocked("chat")).toBe(true);
      expect(conn.isUnlocked("watch")).toBe(true);

      // Trigger CredentialRejected from act.invoke → tokenPaste fixes → degrade.
      const act = conn.act as Act;
      const actor = fx.actorFactory.instances.at(-1);
      if (!actor) throw new Error("actor not built");
      actor.state.nextInvokeError = new CredentialRejected({ grant: "bot" });
      await expect(act.invoke({ operation: "op" })).rejects.toBeInstanceOf(CredentialRejected);
      await flush();

      expect(conn.auth.grants().bot).toBe("degraded");
      expect(heard).toEqual(["connected", "fixed", "broken"]);
      expect(conn.act).toBeNull();
      expect(conn.isUnlocked("chat")).toBe(false);
      expect(conn.isUnlocked("watch")).toBe(false);
      expect(conn.status()).toEqual({
        chat: { state: "needs-auth", missingGrants: ["bot"] },
        act: { state: "needs-auth", missingGrants: ["bot"] },
        watch: { state: "needs-auth", missingGrants: ["bot"] },
      });
      const talker = fx.talkerFactory.instances.at(-1);
      if (!talker) throw new Error("talker not built");
      expect(talker.state.stopCount).toBe(1);
    });
  });

  // Scenario 6 — renew-once-then-degrade
  describe("scenario 6: renew-once-then-degrade", () => {
    it("first rejection renews (old actor discarded, new material), original error rethrown; second degrades", async () => {
      const ledger = makeLedger();
      const registry = new ConnectionRegistry({ repository: ledger });
      // successCount:1 → renews once, then fixes.
      const fx = makeRenewableAct({ successCount: 1 });
      registry.register(fx.descriptor);
      const conn = await registry.connect("fake-github");
      await registry.giveGrant(conn.connectionKind, conn.id, "user", fx.userCredential());

      expect(conn.act).not.toBeNull();
      const act = conn.act as Act;
      const firstActor = fx.actorFactory.instances.at(-1);
      if (!firstActor) throw new Error("first actor not built");
      const buildsBefore = fx.actorFactory.instances.length;

      // First rejection: renew succeeds → epoch rebuilt with NEW credential.
      const boom = new CredentialRejected({ grant: "user" });
      firstActor.state.nextInvokeError = boom;
      // The caller sees the ORIGINAL error rethrown.
      await expect(act.invoke({ operation: "op-1" })).rejects.toBe(boom);
      await flush();

      // A new actor was built (epoch rebuilt); teardown stopped the old actor's
      // retained work before the renewed credential epoch became current.
      expect(fx.actorFactory.instances.length).toBe(buildsBefore + 1);
      expect(firstActor.state.stopCount).toBe(1);
      const secondActor = fx.actorFactory.instances.at(-1);
      if (!secondActor) throw new Error("second actor not built");
      expect(secondActor).not.toBe(firstActor);
      expect(conn.auth.grants().user).toBe("authorized");
      expect(conn.act).not.toBeNull();

      // The new actor was built with the RENEWED material, not the original.
      // renew() hands out { token: "renewed-<n>" }; grant'd/imported was
      // "initial-user-token". Assert the build creds differ from the original.
      const newCred = secondActor.state.invocations; // not yet invoked
      expect(newCred.length).toBe(0);
      // Inspect the creds the second actor was constructed with via a probe call.
      const probe = conn.act as Act;
      await probe.invoke({ operation: "probe" });
      const usedMaterial = secondActor.state.invocations[0]?.cred.material;
      expect(typeof usedMaterial).toBe("object");
      expect((usedMaterial as Record<string, string>).token).toMatch(/^renewed-/);
      expect((usedMaterial as Record<string, string>).token).not.toBe("initial-user-token");

      // Second rejection: renewed flag is set (renewsRemaining now 0) → degrade.
      const boom2 = new CredentialRejected({ grant: "user" });
      secondActor.state.nextInvokeError = boom2;
      await expect(probe.invoke({ operation: "op-2" })).rejects.toBe(boom2);
      await flush();

      expect(conn.auth.grants().user).toBe("degraded");
      expect(conn.act).toBeNull();
      expect(conn.status().act).toEqual({ state: "needs-auth", missingGrants: ["user"] });
      expect(secondActor.state.stopCount).toBe(1);

      // Degrade reason is persisted in the ledger.
      const rec = await ledger.grantOf(conn.id);
      expect(rec?.state).toBe("degraded");
      expect(rec?.degraded?.reason).toBeTruthy();
      // Invariant: credential present ⇔ state !== "unauthorized".
      // "degraded" retains the last (now inert) credential; only fix
      // replaces it. The in-memory live credential is dropped so nothing uses it.
      expect(rec?.credential).toBeDefined();
    });

    // Regression (ledger-first invariant): a transient ledger write failure
    // during a fault-driven degrade must (a) never leak an unhandled rejection
    // (which under Node's default --unhandled-rejections=throw would crash the
    // host), and (b) leave the grant AUTHORIZED in both memory and the ledger
    // with its epoch alive — a DB blip must not half-degrade. A subsequent
    // CredentialRejected with the ledger healthy again degrades normally.
    it("a ledger write failure during degrade leaves the grant authorized (memory + ledger, epoch alive) and does not crash; a later degrade succeeds", async () => {
      // The degrade write rejects (transient DB error) only while `failDegrade`
      // is set; flip it off to let a later degrade land.
      let failDegrade = true;
      const failing = makeFailingLedger((grant) => grant.state === "degraded" && failDegrade);
      const registry = new ConnectionRegistry({ repository: failing });
      // successCount:0 → renew always fixes → degrade attempt → write throws.
      const fx = makeRenewableAct({ successCount: 0 });
      registry.register(fx.descriptor);
      const conn = await registry.connect("fake-github");
      await registry.giveGrant(conn.connectionKind, conn.id, "user", fx.userCredential());

      const act = conn.act as Act;
      const actor = fx.actorFactory.instances.at(-1);
      if (!actor) throw new Error("actor not built");

      const rejections: unknown[] = [];
      const onRejection = (err: unknown): void => {
        rejections.push(err);
      };
      process.on("unhandledRejection", onRejection);
      try {
        const boom = new CredentialRejected({ grant: "user" });
        actor.state.nextInvokeError = boom;
        // The caller still sees the original error rethrown synchronously.
        await expect(act.invoke({ operation: "op" })).rejects.toBe(boom);
        // Let the async degrade flow (whose ledger write throws) settle, plus a
        // microtask turn so any missing .catch would surface as unhandled.
        await flush();
        await flush();
      } finally {
        process.off("unhandledRejection", onRejection);
      }

      // (a) No unhandled rejection escaped.
      expect(rejections).toEqual([]);
      // (b) Ledger-first: the failed degrade write left the grant authorized in
      // memory with a live capability (epoch intact) — no split-brain relock.
      expect(conn.auth.grants().user).toBe("authorized");
      expect(conn.act).not.toBeNull();
      // And the ledger row is unchanged — still authorized, not degraded.
      const rec = await failing.grantOf(conn.id);
      expect(rec?.state).toBe("authorized");
      expect(rec?.degraded).toBeUndefined();

      // With the ledger healthy again, a subsequent CredentialRejected degrades
      // normally (renew fixes → degrade write now lands).
      failDegrade = false;
      const actor2 = fx.actorFactory.instances.at(-1);
      if (!actor2) throw new Error("actor2 not built");
      const boom2 = new CredentialRejected({ grant: "user" });
      actor2.state.nextInvokeError = boom2;
      await expect(act.invoke({ operation: "op-2" })).rejects.toBe(boom2);
      await flush();
      await flush();

      expect(conn.auth.grants().user).toBe("degraded");
      expect(conn.act).toBeNull();
      const rec2 = await failing.grantOf(conn.id);
      expect(rec2?.state).toBe("degraded");
      expect(rec2?.degraded?.reason).toBeTruthy();
    });

    // Regression (ledger-first invariant): a ledger write failure during
    // a grant must reject the call and leave the mirror untouched —
    // the grant stays in its PRIOR state with no split-brain (status(), the
    // capability handle, and the ledger row all agree), and no rebuild happens.
    it("a ledger write failure during a grant rejects and leaves the prior state coherent", async () => {
      let failImport = false;
      const failing = makeFailingLedger((grant) => grant.state === "authorized" && failImport);
      const registry = new ConnectionRegistry({ repository: failing });
      const fx = makePasteTalk();
      registry.register(fx.descriptor);
      const conn = await registry.connect("fake-telegram");

      // Prior state: unauthorized, no talk handle.
      expect(conn.auth.grants().bot).toBe("unauthorized");
      expect(conn.isUnlocked("chat")).toBe(false);
      const buildsBefore = fx.talkerFactory.instances.length;

      // The import's authorize write throws → the call rejects.
      failImport = true;
      await expect(
        registry.giveGrant(conn.connectionKind, conn.id, "bot", fx.validCredential()),
      ).rejects.toThrow(/LEDGER_WRITE_FAILED/);

      // Mirror untouched: grant still unauthorized, no epoch built, status agrees,
      // and the ledger row is unchanged (still unauthorized).
      expect(conn.auth.grants().bot).toBe("unauthorized");
      expect(conn.isUnlocked("chat")).toBe(false);
      expect(conn.status().chat).toEqual({ state: "needs-auth", missingGrants: ["bot"] });
      expect(fx.talkerFactory.instances.length).toBe(buildsBefore);
      const rec = await failing.grantOf(conn.id);
      expect(rec?.state).toBe("unauthorized");
      expect(rec?.credential).toBeUndefined();

      // With the ledger healthy, the same import now succeeds and unlocks talk.
      failImport = false;
      await registry.giveGrant(conn.connectionKind, conn.id, "bot", fx.validCredential());
      expect(conn.auth.grants().bot).toBe("authorized");
      expect(conn.isUnlocked("chat")).toBe(true);
    });
  });

  // Scenario 7 — re-authorize clears the renewed flag
  describe("scenario 7: re-authorize clears renewed flag", () => {
    it("after degrade, re-authorize re-unlocks + fires onUnlocked; a later rejection renews again instead of instantly degrading", async () => {
      const ledger = makeLedger();
      const registry = new ConnectionRegistry({ repository: ledger });
      // Allow many renewals so the flag (not exhaustion) is what would degrade.
      const fx = makeRenewableAct({ successCount: 100 });
      registry.register(fx.descriptor);
      const conn = await registry.connect("fake-github");

      const unlocks: Connection[] = [];
      registry.onUnlocked("act", (c) => unlocks.push(c));

      await registry.giveGrant(conn.connectionKind, conn.id, "user", fx.userCredential());
      expect(unlocks.length).toBe(1); // initial unlock

      const actor1 = fx.actorFactory.instances.at(-1);
      if (!actor1) throw new Error("actor1 not built");

      // First rejection → renew succeeds (flag now set) → still authorized.
      actor1.state.nextInvokeError = new CredentialRejected({ grant: "user" });
      await expect((conn.act as Act).invoke({ operation: "a" })).rejects.toBeInstanceOf(
        CredentialRejected,
      );
      await flush();
      expect(conn.auth.grants().user).toBe("authorized");

      // Second rejection with the flag still set → degrade.
      const actor2 = fx.actorFactory.instances.at(-1);
      if (!actor2) throw new Error("actor2 not built");
      actor2.state.nextInvokeError = new CredentialRejected({ grant: "user" });
      await expect((conn.act as Act).invoke({ operation: "b" })).rejects.toBeInstanceOf(
        CredentialRejected,
      );
      await flush();
      expect(conn.auth.grants().user).toBe("degraded");
      expect(conn.act).toBeNull();

      // Re-authorize via grant (new material clears the flag + re-unlocks).
      const unlocksBeforeReauth = unlocks.length;
      await registry.giveGrant(conn.connectionKind, conn.id, "user", {
        material: { token: "reauthorized-token" },
        expiresAt: "never",
      });
      expect(conn.auth.grants().user).toBe("authorized");
      expect(conn.act).not.toBeNull();
      // onUnlocked re-fires on re-authorize.
      expect(unlocks.length).toBe(unlocksBeforeReauth + 1);

      // A later rejection should RENEW again (flag cleared), not instantly degrade.
      const actor3 = fx.actorFactory.instances.at(-1);
      if (!actor3) throw new Error("actor3 not built");
      actor3.state.nextInvokeError = new CredentialRejected({ grant: "user" });
      await expect((conn.act as Act).invoke({ operation: "c" })).rejects.toBeInstanceOf(
        CredentialRejected,
      );
      await flush();
      // Renewed, not degraded — the flag was cleared by re-authorize.
      expect(conn.auth.grants().user).toBe("authorized");
      expect(conn.act).not.toBeNull();
    });
  });

  // Scenario 8 — epoch handle death + fresh talker
  describe("scenario 8: epoch handle death + fresh talker", () => {
    it("revoke ends the talker's epoch and its listeners; re-import reaches a NEW talker", async () => {
      const ledger = makeLedger();
      const registry = new ConnectionRegistry({ repository: ledger });
      const fx = makePasteTalk();
      registry.register(fx.descriptor);
      const conn = await registry.connect("fake-telegram");
      await registry.giveGrant(conn.connectionKind, conn.id, "bot", fx.validCredential());

      expect(conn.isUnlocked("chat")).toBe(true);
      const heard: ChannelMessage[] = [];
      expect(conn.hearTalker(async (msg) => void heard.push(msg))).not.toBeNull();
      await conn.withTalker((talker) =>
        talker.send("thread-1" as ChatId, { text: "before revoke" }),
      );
      const oldTalker = fx.talkerFactory.instances.at(-1);
      if (!oldTalker) throw new Error("talker not built");

      // Revoke the grant → epoch dies, and nothing reaches a talker.
      await conn.auth.revoke("bot");
      expect(conn.isUnlocked("chat")).toBe(false);
      expect(conn.auth.grants().bot).toBe("unauthorized");
      expect(conn.withTalker(() => "reached")).toBeUndefined();
      expect(conn.hearTalker(async () => {})).toBeNull();

      // Re-import → a NEW talker, which the old epoch's listener does not hear.
      await registry.giveGrant(conn.connectionKind, conn.id, "bot", fx.validCredential());
      expect(conn.isUnlocked("chat")).toBe(true);
      const newTalker = fx.talkerFactory.instances.at(-1);
      if (!newTalker) throw new Error("talker not rebuilt");
      expect(newTalker).not.toBe(oldTalker);
      await conn.withTalker((talker) =>
        talker.send("thread-1" as ChatId, { text: "after reimport" }),
      );
      expect(newTalker.state.sends.map((s) => s.msg)).toEqual([{ text: "after reimport" }]);
      newTalker.state.deliver?.(makeInboundMessage({ messageId: "after-reimport" }));
      await flush();
      expect(heard).toEqual([]);
    });
  });

  // A talker reached through `withTalker` reports a rejected credential the way
  // `act.invoke` does: thrown or rejected, from `send` or from a feature.
  describe("faults through withTalker", () => {
    async function unlocked() {
      const registry = new ConnectionRegistry({ repository: makeLedger() });
      const fx = makePasteTalk();
      registry.register(fx.descriptor);
      const conn = await registry.connect("fake-telegram");
      await registry.giveGrant(conn.connectionKind, conn.id, "bot", fx.validCredential());
      const talker = fx.talkerFactory.instances.at(-1);
      if (!talker) throw new Error("talker not built");
      return { registry, fx, conn, talker };
    }

    it("degrades the grant when a feature call rejects with CredentialRejected", async () => {
      const { conn, talker } = await unlocked();
      talker.history = {
        query: async () => {
          throw new CredentialRejected({ grant: "bot" });
        },
      };

      await expect(conn.withTalker((live) => live.history?.query({}))).rejects.toBeInstanceOf(
        CredentialRejected,
      );
      await flush();

      expect(conn.auth.grants().bot).toBe("degraded");
      expect(conn.isUnlocked("chat")).toBe(false);
    });

    it("degrades the grant when the call throws CredentialRejected", async () => {
      const { conn } = await unlocked();

      expect(() =>
        conn.withTalker(() => {
          throw new CredentialRejected({ grant: "bot" });
        }),
      ).toThrow(CredentialRejected);
      await flush();

      expect(conn.auth.grants().bot).toBe("degraded");
      expect(conn.isUnlocked("chat")).toBe(false);
    });

    it("ignores a rejection that settles after its epoch was replaced", async () => {
      const { registry, fx, conn, talker } = await unlocked();
      let reject: (err: unknown) => void = () => {};
      talker.history = {
        query: () =>
          new Promise((_resolve, rejectRead) => {
            reject = rejectRead;
          }),
      };
      const pending = conn.withTalker((live) => live.history?.query({}));

      await conn.auth.revoke("bot");
      await registry.giveGrant(conn.connectionKind, conn.id, "bot", fx.validCredential());
      reject(new CredentialRejected({ grant: "bot" }));
      await expect(pending).rejects.toBeInstanceOf(CredentialRejected);
      await flush();

      expect(conn.auth.grants().bot).toBe("authorized");
      expect(conn.isUnlocked("chat")).toBe(true);
    });
  });

  // Late faults from a discarded epoch must not touch grant state: transports
  // fire terminal errors from in-flight work while teardown is still draining
  // (WeChat's poll 401 after stop, Baileys' loggedOut close). Acting on one
  // would flip a just-revoked grant unauthorized→degraded.
  describe("late fault after epoch discard", () => {
    it("a CredentialRejected fired by the OLD instance after revoke leaves the grant unauthorized", async () => {
      const ledger = makeLedger();
      const registry = new ConnectionRegistry({ repository: ledger });
      const fx = makePasteTalk();
      registry.register(fx.descriptor);
      const conn = await registry.connect("fake-telegram");
      await registry.giveGrant(conn.connectionKind, conn.id, "bot", fx.validCredential());

      // Capture the OLD instance's fault callback, then revoke (epoch dies).
      const oldFault = fx.talkerFactory.instances[0].state.fault;
      expect(oldFault).not.toBeNull();
      await conn.auth.revoke("bot");
      expect(conn.auth.grants().bot).toBe("unauthorized");

      // The in-flight transport reports an auth failure AFTER the discard.
      oldFault!(new CredentialRejected({ grant: "bot" }));
      await new Promise((r) => setTimeout(r, 0)); // let any (wrong) async flow run

      expect(conn.auth.grants().bot).toBe("unauthorized");
      expect((await ledger.grantOf(conn.id))?.state).toBe("unauthorized");
    });

    it("a late fault from a SUPERSEDED epoch does not renew or degrade the new epoch's grant", async () => {
      const ledger = makeLedger();
      const registry = new ConnectionRegistry({ repository: ledger });
      const fx = makePasteTalk();
      registry.register(fx.descriptor);
      const conn = await registry.connect("fake-telegram");
      await registry.giveGrant(conn.connectionKind, conn.id, "bot", fx.validCredential());
      const oldFault = fx.talkerFactory.instances[0].state.fault;

      // New material → new epoch; the old instance was discarded.
      await registry.giveGrant(conn.connectionKind, conn.id, "bot", {
        material: { token: "rotated-token" },
        expiresAt: "never",
      });
      expect(conn.auth.grants().bot).toBe("authorized");

      oldFault!(new CredentialRejected({ grant: "bot" }));
      await new Promise((r) => setTimeout(r, 0));

      // Still authorized: the stale fault neither renewed nor degraded.
      expect(conn.auth.grants().bot).toBe("authorized");
      expect((await ledger.grantOf(conn.id))?.state).toBe("authorized");
    });
  });

  // Scenario 9 — old instance stopped before new build (ordering)
  describe("scenario 9: stop-before-build ordering", () => {
    it("re-authorize stops the old instance before building the new one", async () => {
      const ledger = makeLedger();
      const registry = new ConnectionRegistry({ repository: ledger });
      const fx = makePasteTalk();
      registry.register(fx.descriptor);
      const conn = await registry.connect("fake-telegram");

      // Record the global order of stop() vs build() across instances.
      const order: string[] = [];
      // Wrap the factory build so we log the build event and each instance's stop.
      const originalBuild = fx.descriptor.capabilities.talker?.build;
      if (!originalBuild) throw new Error("talker build missing");
      let buildIndex = 0;
      fx.descriptor.capabilities.talker!.build = (cred, kit) => {
        const idx = buildIndex++;
        order.push(`build:${idx}`);
        const instance = originalBuild(cred, kit);
        const originalStop = instance.stop.bind(instance);
        instance.stop = () => {
          order.push(`stop:${idx}`);
          originalStop();
        };
        return instance;
      };

      // First authorize builds instance 0.
      await registry.giveGrant(conn.connectionKind, conn.id, "bot", fx.validCredential());
      expect(order).toEqual(["build:0"]);

      // Re-authorize with DIFFERENT material → epoch rebuild: stop old, build new.
      await registry.giveGrant(conn.connectionKind, conn.id, "bot", {
        material: { token: "different-token" },
        expiresAt: "never",
      });

      // Ordering: instance 0 is stopped BEFORE instance 1 is built.
      expect(order).toEqual(["build:0", "stop:0", "build:1"]);
      const idxStop0 = order.indexOf("stop:0");
      const idxBuild1 = order.indexOf("build:1");
      expect(idxStop0).toBeLessThan(idxBuild1);
    });
  });

  // Scenario 10 — Disconnected backoff
  describe("scenario 10: Disconnected backoff", () => {
    it("faults rebuild the SAME epoch with SAME material, durations grow exponentially, grant untouched, no onUnlocked re-fire", async () => {
      const ledger = makeLedger();
      const sleep = makeRecordingSleep();
      const registry = new ConnectionRegistry({
        repository: ledger,
        sleep: sleep.fn,
        backoff: { baseMs: 100, maxMs: 10_000 },
      });
      const fx = makePasteTalk();
      registry.register(fx.descriptor);
      const conn = await registry.connect("fake-telegram");

      const unlocks: Connection[] = [];
      registry.onUnlocked("chat", (c) => unlocks.push(c));

      await registry.giveGrant(conn.connectionKind, conn.id, "bot", fx.validCredential());
      expect(unlocks.length).toBe(1); // initial unlock only

      const instance0 = fx.talkerFactory.instances.at(-1);
      if (!instance0) throw new Error("instance0 not built");
      const grantsBefore = { ...conn.auth.grants() };

      // First Disconnected fault → stop, sleep(base=100), rebuild same epoch.
      instance0.state.fault?.(new Disconnected());
      await flush();

      expect(sleep.durations).toEqual([100]);
      // A new internal instance was built for the backoff rebuild.
      expect(fx.talkerFactory.instances.length).toBe(2);
      const instance1 = fx.talkerFactory.instances.at(-1);
      if (!instance1) throw new Error("instance1 not built");
      expect(instance1).not.toBe(instance0);
      // Same material used on rebuild.
      expect(instance1.state.starts[0]?.cred.material).toEqual(
        instance0.state.starts[0]?.cred.material,
      );
      // A send through the Connection after the backoff rebuild routes to the
      // NEW instance.
      await conn.withTalker((talker) =>
        talker.send("thread-1" as ChatId, { text: "after reconnect" }),
      );
      expect(instance1.state.sends.map((s) => s.msg)).toContainEqual({ text: "after reconnect" });

      // Second CONSECUTIVE Disconnected (no successful delivery between) → base*2.
      instance1.state.fault?.(new Disconnected());
      await flush();
      expect(sleep.durations).toEqual([100, 200]);

      const instance2 = fx.talkerFactory.instances.at(-1);
      if (!instance2) throw new Error("instance2 not built");

      // Third consecutive → base*4.
      instance2.state.fault?.(new Disconnected());
      await flush();
      expect(sleep.durations).toEqual([100, 200, 400]);

      // Grant state never touched by Disconnected; no onUnlocked re-fire.
      expect(conn.auth.grants()).toEqual(grantsBefore);
      expect(conn.auth.grants().bot).toBe("authorized");
      expect(unlocks.length).toBe(1);

      // Wrapper still usable after the whole backoff run.
      const instance3 = fx.talkerFactory.instances.at(-1);
      if (!instance3) throw new Error("instance3 not built");
      await conn.withTalker((talker) => talker.send("thread-1" as ChatId, { text: "final" }));
      expect(instance3.state.sends.map((s) => s.msg)).toContainEqual({ text: "final" });
    });

    it("a successful delivery between faults resets the backoff exponent", async () => {
      const ledger = makeLedger();
      const sleep = makeRecordingSleep();
      const registry = new ConnectionRegistry({
        repository: ledger,
        sleep: sleep.fn,
        backoff: { baseMs: 100, maxMs: 10_000 },
      });
      const fx = makePasteTalk();
      registry.register(fx.descriptor);
      const conn = await registry.connect("fake-telegram");
      await registry.giveGrant(conn.connectionKind, conn.id, "bot", fx.validCredential());

      const inst0 = fx.talkerFactory.instances.at(-1);
      if (!inst0) throw new Error("inst0 not built");

      // Fault once → base.
      inst0.state.fault?.(new Disconnected());
      await flush();
      expect(sleep.durations).toEqual([100]);

      // Deliver a message through the rebuilt instance → resets disconnectStreak.
      const inst1 = fx.talkerFactory.instances.at(-1);
      if (!inst1) throw new Error("inst1 not built");
      inst1.state.deliver?.({
        channel: "test",
        direction: "inbound",
        messageId: "m",
        chatId: "thread-1" as ChatId,
        senderId: "s",
        senderDisplayName: "S",
        thread: { kind: "dm" },
        text: "hi",
        attachments: [],
        timestamp: new Date(0),
      });

      // Next fault should start again from base, not base*2.
      inst1.state.fault?.(new Disconnected());
      await flush();
      expect(sleep.durations).toEqual([100, 100]);
    });

    // Regression: write-through custody must survive a bare backoff rebuild.
    // kit.persist replaces the live credential in place without an epoch
    // rebuild; a subsequent Disconnected rebuild must reconstruct the instance
    // with the POST-persist material, not the material frozen at build time.
    it("Disconnected rebuild after kit.persist uses the persisted (rotated) material", async () => {
      const ledger = makeLedger();
      const sleep = makeRecordingSleep();
      const registry = new ConnectionRegistry({
        repository: ledger,
        sleep: sleep.fn,
        backoff: { baseMs: 1, maxMs: 1 },
      });

      // Capture the kit handed to build() so we can drive kit.persist directly.
      let capturedKit: import("./types.js").RuntimeKit | null = null;
      const fx = makePasteTalk();
      const originalBuild = fx.descriptor.capabilities.talker!.build;
      fx.descriptor.capabilities.talker = {
        ...fx.descriptor.capabilities.talker!,
        build(cred, kit) {
          capturedKit = kit;
          return originalBuild(cred, kit);
        },
      };
      registry.register(fx.descriptor);
      const conn = await registry.connect("fake-telegram");
      await registry.giveGrant(conn.connectionKind, conn.id, "bot", fx.validCredential());
      expect(capturedKit).not.toBeNull();

      const instance0 = fx.talkerFactory.instances.at(-1);
      if (!instance0) throw new Error("instance0 not built");

      // Write-through custody: rotate the material in place. No rebuild yet.
      await capturedKit!.persist({ token: "rotated-token" });
      expect(fx.talkerFactory.instances.length).toBe(1); // no rebuild on persist

      // Now a Disconnected fault forces a backoff rebuild.
      instance0.state.fault?.(new Disconnected());
      await flush();

      const instance1 = fx.talkerFactory.instances.at(-1);
      if (!instance1) throw new Error("instance1 not built");
      expect(instance1).not.toBe(instance0);
      // The rebuilt instance must see the ROTATED material, not "fake-bot-token".
      expect(instance1.state.starts[0]?.cred.material).toEqual({ token: "rotated-token" });
    });
  });

  // Scenario 11 — onUnlocked fires before the stream starts (first-delivery)
  describe("scenario 11: onUnlocked fires before start()", () => {
    it("a handler registered synchronously in onUnlocked catches a message the Talker delivers from start()", async () => {
      const ledger = makeLedger();
      const registry = new ConnectionRegistry({ repository: ledger });
      const fx = makePasteTalk();
      // The Talker will synchronously flush one buffered inbound message the
      // instant its start() runs. Arm the flush on the fake talker the factory
      // produces (build() runs synchronously inside the grant, before
      // start(), so the knob is set in time).
      const flushed = makeInboundMessage({
        messageId: "buffered-1",
        text: "buffered on start",
      });
      const originalBuild = fx.talkerFactory.build.bind(fx.talkerFactory);
      fx.talkerFactory.build = (cred) => {
        const t = originalBuild(cred);
        t.state.flushOnStart = [flushed];
        return t;
      };
      registry.register(fx.descriptor);
      const conn = await registry.connect("fake-telegram");

      // Register the unlock handler BEFORE the epoch is built. When chat unlocks,
      // the handler synchronously registers an onMessage listener — which must be
      // wired before start() runs, or the buffered flush is lost.
      const received: ChannelMessage[] = [];
      registry.onUnlocked("chat", (c) => {
        c.hearTalker(async (msg) => {
          received.push(msg);
        });
      });

      // Authorize → buildEpoch fires onUnlocked (handler registers) → start()
      // (flushes the buffered message into the now-wired handler).
      await registry.giveGrant(conn.connectionKind, conn.id, "bot", fx.validCredential());
      await flush();

      // Before the fix (start before onUnlocked) the buffered message dropped
      // into empty handler arrays; after the fix it is delivered.
      expect(received.map((m) => m.messageId)).toContain("buffered-1");
      expect(received.map((m) => m.text)).toContain("buffered on start");
    });
  });
});

// Post-callback epoch guard: the CredentialRejected flow re-checks its source
// epoch immediately before applying state. handleFault's invocation-time guard
// only covers the pre-callback window; the flow then awaits (scheme.renew,
// ledger writes), and a grant completing in that window tears down the
// faulting epoch — the stale flow must become a no-op, never persist `degraded`
// (or a renewed credential) over the fresh grant.

describe("credential-rejected flow vs. a grant completing mid-flow", () => {
  it("a re-login completing while the fault flow is parked in renew() cannot degrade the fresh grant", async () => {
    const ledger = makeLedger();
    const registry = new ConnectionRegistry({ repository: ledger });
    const talkerFactory = makeFakeTalkerFactory();
    // A session-like scheme whose renew() parks on a test-controlled gate before
    // answering "needs-fix" — the widest await in the fault flow.
    let releaseRenew!: () => void;
    const renewGate = new Promise<void>((resolve) => {
      releaseRenew = resolve;
    });
    let renewStarted = false;
    const descriptor: ConnectionDescriptor = {
      connectionKind: "fake-session-svc",
      grant: "session",
      auth: {
        async obtain(): Promise<Credential> {
          throw new Error("route-driven");
        },
        async renew(): Promise<Credential | "needs-fix"> {
          renewStarted = true;
          await renewGate;
          return "needs-fix";
        },
      },
      capabilities: {
        talker: { build: (cred) => talkerFactory.build(cred) },
      },
    };
    registry.register(descriptor);
    const conn = await registry.connect("fake-session-svc");
    await registry.giveGrant(conn.connectionKind, conn.id, "session", {
      material: { token: "tok-old" },
      expiresAt: "never",
    });
    const epochATalker = talkerFactory.instances.at(-1);
    if (!epochATalker) throw new Error("epoch A talker not built");

    // Epoch A's live stream reports a refused credential; the flow starts and
    // parks inside scheme.renew.
    epochATalker.state.fault?.(new CredentialRejected({ grant: "session" }));
    await flush();
    expect(renewStarted).toBe(true);
    expect(conn.auth.grants().session).toBe("authorized"); // not yet degraded

    // A re-login completes mid-flow: fresh credential, fresh epoch (A torn down).
    await registry.giveGrant(conn.connectionKind, conn.id, "session", {
      material: { token: "tok-fresh" },
      expiresAt: "never",
    });
    expect(conn.auth.grants().session).toBe("authorized");
    const epochBTalker = talkerFactory.instances.at(-1);
    expect(epochBTalker).not.toBe(epochATalker);

    // The parked flow now resumes and answers "needs-fix" — but its source epoch
    // is dead, so it must NOT persist `degraded` over the fresh grant.
    releaseRenew();
    await flush();
    await flush();

    expect(conn.auth.grants().session).toBe("authorized");
    expect(conn.isUnlocked("chat")).toBe(true);
    const grant = await ledger.grantOf(conn.id);
    expect(grant?.state).toBe("authorized");
    expect(grant?.degraded).toBeUndefined();
    expect(grant?.credential).toMatchObject({
      material: { kind: "inline", record: { token: "tok-fresh" } },
    });
    // The fresh epoch was never relocked by the stale flow.
    expect(epochBTalker?.state.stopCount).toBe(0);
  });

  /** A ledger whose FIRST updateGrant matching `shouldGate` parks on a
   *  test-controlled gate before delegating — models a slow durable write so a
   *  grant can complete INSIDE the fault flow's awaited ledger call. All
   *  other calls (including the grant's own writes and any repair write)
   *  pass straight through. */
  function makeGatedLedger(shouldGate: (grant: GrantValue) => boolean): {
    ledger: ConnectionsRepository;
    release: () => void;
  } {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let gatedOnce = false;
    class GatedLedger extends DrizzleConnectionsRepository {
      override async update(
        id: ConnectionId,
        next: (current: StoredConnection) => StoredConnection,
        inTx?: (tx: DrizzleTx) => void,
      ) {
        const current = await this.get(id);
        if (current && !gatedOnce && shouldGate(next(current).grant)) {
          gatedOnce = true;
          await gate;
        }
        return super.update(id, next, inTx);
      }
    }
    return { ledger: new GatedLedger(createTestDb().db), release };
  }

  function makeSessionDescriptor(
    talkerFactory: ReturnType<typeof makeFakeTalkerFactory>,
    renew: () => Promise<Credential | "needs-fix">,
  ): ConnectionDescriptor {
    return {
      connectionKind: "fake-session-svc",
      grant: "session",
      auth: {
        async obtain(): Promise<Credential> {
          throw new Error("route-driven");
        },
        renew,
      },
      capabilities: {
        talker: { build: (cred) => talkerFactory.build(cred) },
      },
    };
  }

  it("a re-login during the degrade write waits for it, then leaves the fresh grant and epoch", async () => {
    // Gate the degrade row write itself, after the flow took the grant's lock.
    const { ledger, release } = makeGatedLedger((grant) => grant.state === "degraded");
    const registry = new ConnectionRegistry({ repository: ledger });
    const talkerFactory = makeFakeTalkerFactory();
    registry.register(makeSessionDescriptor(talkerFactory, async () => "needs-fix"));
    const conn = await registry.connect("fake-session-svc");
    await registry.giveGrant(conn.connectionKind, conn.id, "session", {
      material: { token: "tok-old" },
      expiresAt: "never",
    });
    const epochATalker = talkerFactory.instances.at(-1);
    if (!epochATalker) throw new Error("epoch A talker not built");

    // Fault → renew answers "needs-fix" → degradeGrant starts its write under
    // the grant's lock and parks inside it.
    epochATalker.state.fault?.(new CredentialRejected({ grant: "session" }));
    await flush();
    expect(conn.auth.grants().session).toBe("authorized"); // write parked, nothing applied

    // A re-login arrives during the parked write. It waits for the lock, so
    // nothing it builds can be torn down by the break.
    const relogin = registry.giveGrant(conn.connectionKind, conn.id, "session", {
      material: { token: "tok-fresh" },
      expiresAt: "never",
    });
    await flush();
    expect(talkerFactory.instances.at(-1)).toBe(epochATalker);

    // The break lands, then the re-login fixes it.
    release();
    await relogin;
    const epochBTalker = talkerFactory.instances.at(-1);
    expect(epochBTalker).not.toBe(epochATalker);

    expect(conn.auth.grants().session).toBe("authorized");
    expect(conn.isUnlocked("chat")).toBe(true);
    expect(epochBTalker?.state.stopCount).toBe(0);
    const grant = await ledger.grantOf(conn.id);
    expect(grant?.state).toBe("authorized");
    expect(grant?.degraded).toBeUndefined();
    expect(grant?.credential).toMatchObject({
      material: { kind: "inline", record: { token: "tok-fresh" } },
    });
  });

  it("a re-login during a successful renewal's write waits for it, then replaces the renewed credential", async () => {
    // Gate the renewal row write (the only fault-path write with lastRenewedAt).
    const { ledger, release } = makeGatedLedger((grant) => grant.lastRenewedAt !== undefined);
    const registry = new ConnectionRegistry({ repository: ledger });
    const talkerFactory = makeFakeTalkerFactory();
    registry.register(
      makeSessionDescriptor(talkerFactory, async () => ({
        material: { token: "tok-renewed" },
        expiresAt: "never" as const,
      })),
    );
    const conn = await registry.connect("fake-session-svc");
    await registry.giveGrant(conn.connectionKind, conn.id, "session", {
      material: { token: "tok-old" },
      expiresAt: "never",
    });
    const epochATalker = talkerFactory.instances.at(-1);
    if (!epochATalker) throw new Error("epoch A talker not built");

    // Fault → renew succeeds → the authorized+renewed write parks under the
    // grant's lock.
    epochATalker.state.fault?.(new CredentialRejected({ grant: "session" }));
    await flush();

    // A re-login arrives during the parked write and waits for the lock.
    const relogin = registry.giveGrant(conn.connectionKind, conn.id, "session", {
      material: { token: "tok-fresh" },
      expiresAt: "never",
    });
    await flush();

    // The renewal lands, then the re-login replaces it.
    release();
    await relogin;
    const epochBTalker = talkerFactory.instances.at(-1);
    expect(epochBTalker).not.toBe(epochATalker);
    const buildsAfterRelogin = talkerFactory.instances.length;
    await flush();
    await flush();

    expect(conn.auth.grants().session).toBe("authorized");
    expect(conn.isUnlocked("chat")).toBe(true);
    expect(epochBTalker?.state.stopCount).toBe(0);
    expect(talkerFactory.instances.length).toBe(buildsAfterRelogin); // nothing rebuilt after
    const grant = await ledger.grantOf(conn.id);
    expect(grant?.state).toBe("authorized");
    expect(grant?.credential).toMatchObject({
      material: { kind: "inline", record: { token: "tok-fresh" } },
    });
  });
});
