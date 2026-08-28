// Fault-handling contract suite. The subtlest semantics:
// degrade relocking only dependents (scenario 5), renew-once-then-degrade
// (scenario 6), re-authorize clearing the renewed flag (scenario 7), epoch
// handle death + fresh wrapper (scenario 8), stop-before-build ordering
// (scenario 9), and Disconnected backoff (scenario 10).
//
// Fault handling in the registry is asynchronous: the wrapper triggers the flow
// with `void this.handle…` then rethrows the original error to the caller. Tests
// therefore push the fault, then `await flush()` (a macrotask) so the renewal /
// backoff flow settles before asserting.

import { describe, expect, it } from "@rstest/core";
import { createTestDb } from "../test/helpers.js";
import type { ConversationId } from "@rome-os/app-runtime";
import { DrizzleGrantLedger } from "./ledger-db.js";
import type { GrantLedger } from "./ledger.js";
import { ConnectionRegistry } from "./registry.js";
import type { Act, Connection, ConnectionDescriptor, Credential, Talk } from "./types.js";
import {
  CredentialRejected,
  Disconnected,
  makeFakeTalkerFactory,
  makeInboundMessage,
  makeRecordingSleep,
  makeRenewableAct,
  makePasteTalk,
  makeTwoGrant,
} from "./test-fixtures.js";
import type { InboundMessage } from "./types.js";

// A macrotask flush: lets the async `void handle…` fault flows (which chain
// awaits over the ledger + reconcile) settle before assertions run.
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// A fresh drizzle-backed ledger per test.
function makeLedger(): GrantLedger {
  return new DrizzleGrantLedger(createTestDb().db);
}

describe("registry faults", () => {
  // Scenario 5 — degrade relocks only dependents
  describe("scenario 5: degrade relocks only dependents", () => {
    it("degrading user (act) leaves talk live", async () => {
      const ledger = makeLedger();
      const registry = new ConnectionRegistry({ ledger });
      const fx = makeTwoGrant();
      registry.register(fx.descriptor);
      const conn = await registry.connect("fake-discord");

      // Authorize both grants: bot → talk+watch, user → act.
      await registry.importCredential(conn.id, "bot", fx.botCredential());
      // user scheme renews then re-confers; make renew return "re-confer" so the
      // very first CredentialRejected degrades immediately (renew-once path
      // covered in scenario 6). successCount:3 by default → force to 0.
      fx.userScheme.renewsRemaining = 0;
      await registry.importCredential(conn.id, "user", fx.userCredential());

      expect(conn.act).not.toBeNull();
      expect(conn.talk).not.toBeNull();
      const talk = conn.talk as Talk;

      // Trigger CredentialRejected from act.invoke → renew re-confers → degrade.
      const act = conn.act as Act;
      const actor = fx.actorFactory.instances.at(-1);
      if (!actor) throw new Error("actor not built");
      actor.state.nextInvokeError = new CredentialRejected({ grant: "user" });
      await expect(act.invoke({ operation: "op" })).rejects.toBeInstanceOf(CredentialRejected);
      await flush();

      // Act relocked; user grant degraded; talk (bot grant) untouched.
      expect(conn.act).toBeNull();
      expect(conn.status().act).toEqual({ state: "needs-auth", missingGrants: ["user"] });
      expect(conn.status().talk).toEqual({ state: "unlocked" });
      expect(conn.talk).not.toBeNull();
      expect(conn.auth.grants().user).toBe("degraded");
      expect(conn.auth.grants().bot).toBe("authorized");

      // The talk handle captured before the degrade still works — send is recorded.
      await talk.send("thread-1" as ConversationId, { text: "still alive" });
      const talker = fx.talkerFactory.instances.at(-1);
      if (!talker) throw new Error("talker not built");
      expect(talker.state.sends.map((s) => s.msg)).toContainEqual({ text: "still alive" });
      // Talk was never stopped by the user-grant degrade.
      expect(talker.state.stopCount).toBe(0);
    });
  });

  // Scenario 6 — renew-once-then-degrade
  describe("scenario 6: renew-once-then-degrade", () => {
    it("first rejection renews (old actor discarded, new material), original error rethrown; second degrades", async () => {
      const ledger = makeLedger();
      const registry = new ConnectionRegistry({ ledger });
      // successCount:1 → renews once, then re-confers.
      const fx = makeRenewableAct({ successCount: 1 });
      registry.register(fx.descriptor);
      const conn = await registry.connect("fake-github");
      await registry.importCredential(conn.id, "user", fx.userCredential());

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
      // renew() hands out { token: "renewed-<n>" }; confer'd/imported was
      // "initial-user-token". Assert the build creds differ from the original.
      const newCred = secondActor.state.invocations; // not yet invoked
      expect(newCred.length).toBe(0);
      // Inspect the creds the second actor was constructed with via a probe call.
      const probe = conn.act as Act;
      await probe.invoke({ operation: "probe" });
      const usedMaterial = secondActor.state.invocations[0]?.creds.user.material;
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
      const rec = await ledger.getGrant(conn.id, "user");
      expect(rec?.state).toBe("degraded");
      expect(rec?.degraded?.reason).toBeTruthy();
      // Invariant: credential present ⇔ state !== "unauthorized".
      // "degraded" retains the last (now inert) credential; only re-confer
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
      const base = makeLedger();
      // Wrap the ledger so the degrade write rejects (transient DB error) only
      // while `failDegrade` is set; flip it off to let a later degrade land.
      let failDegrade = true;
      const failing: GrantLedger = {
        createConnection: (rec) => base.createConnection(rec),
        listConnections: () => base.listConnections(),
        deleteConnection: (id) => base.deleteConnection(id),
        ensureGrant: (c, n) => base.ensureGrant(c, n),
        getGrant: (c, n) => base.getGrant(c, n),
        listGrants: (c) => base.listGrants(c),
        updateGrant: async (c, n, patch) => {
          if (patch.state === "degraded" && failDegrade) {
            throw new Error("LEDGER_WRITE_FAILED");
          }
          return base.updateGrant(c, n, patch);
        },
      };
      const registry = new ConnectionRegistry({ ledger: failing });
      // successCount:0 → renew always re-confers → degrade attempt → write throws.
      const fx = makeRenewableAct({ successCount: 0 });
      registry.register(fx.descriptor);
      const conn = await registry.connect("fake-github");
      await registry.importCredential(conn.id, "user", fx.userCredential());

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
      const rec = await base.getGrant(conn.id, "user");
      expect(rec?.state).toBe("authorized");
      expect(rec?.degraded).toBeUndefined();

      // With the ledger healthy again, a subsequent CredentialRejected degrades
      // normally (renew re-confers → degrade write now lands).
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
      const rec2 = await base.getGrant(conn.id, "user");
      expect(rec2?.state).toBe("degraded");
      expect(rec2?.degraded?.reason).toBeTruthy();
    });

    // Regression (ledger-first invariant): a ledger write failure during
    // importCredential must reject the call and leave the mirror untouched —
    // the grant stays in its PRIOR state with no split-brain (status(), the
    // capability handle, and the ledger row all agree), and no rebuild happens.
    it("a ledger write failure during importCredential rejects and leaves the prior state coherent", async () => {
      const base = makeLedger();
      let failImport = false;
      const failing: GrantLedger = {
        createConnection: (rec) => base.createConnection(rec),
        listConnections: () => base.listConnections(),
        deleteConnection: (id) => base.deleteConnection(id),
        ensureGrant: (c, n) => base.ensureGrant(c, n),
        getGrant: (c, n) => base.getGrant(c, n),
        listGrants: (c) => base.listGrants(c),
        updateGrant: async (c, n, patch) => {
          if (patch.state === "authorized" && failImport) {
            throw new Error("LEDGER_WRITE_FAILED");
          }
          return base.updateGrant(c, n, patch);
        },
      };
      const registry = new ConnectionRegistry({ ledger: failing });
      const fx = makePasteTalk();
      registry.register(fx.descriptor);
      const conn = await registry.connect("fake-telegram");

      // Prior state: unauthorized, no talk handle.
      expect(conn.auth.grants().bot).toBe("unauthorized");
      expect(conn.talk).toBeNull();
      const buildsBefore = fx.talkerFactory.instances.length;

      // The import's authorize write throws → the call rejects.
      failImport = true;
      await expect(registry.importCredential(conn.id, "bot", fx.validCredential())).rejects.toThrow(
        /LEDGER_WRITE_FAILED/,
      );

      // Mirror untouched: grant still unauthorized, no epoch built, status agrees,
      // and the ledger row is unchanged (still unauthorized).
      expect(conn.auth.grants().bot).toBe("unauthorized");
      expect(conn.talk).toBeNull();
      expect(conn.status().talk).toEqual({ state: "needs-auth", missingGrants: ["bot"] });
      expect(fx.talkerFactory.instances.length).toBe(buildsBefore);
      const rec = await base.getGrant(conn.id, "bot");
      expect(rec?.state).toBe("unauthorized");
      expect(rec?.credential).toBeUndefined();

      // With the ledger healthy, the same import now succeeds and unlocks talk.
      failImport = false;
      await registry.importCredential(conn.id, "bot", fx.validCredential());
      expect(conn.auth.grants().bot).toBe("authorized");
      expect(conn.talk).not.toBeNull();
    });
  });

  // Scenario 7 — re-authorize clears the renewed flag
  describe("scenario 7: re-authorize clears renewed flag", () => {
    it("after degrade, re-authorize re-unlocks + fires onUnlocked; a later rejection renews again instead of instantly degrading", async () => {
      const ledger = makeLedger();
      const registry = new ConnectionRegistry({ ledger });
      // Allow many renewals so the flag (not exhaustion) is what would degrade.
      const fx = makeRenewableAct({ successCount: 100 });
      registry.register(fx.descriptor);
      const conn = await registry.connect("fake-github");

      const unlocks: Connection[] = [];
      registry.onUnlocked("act", (c) => unlocks.push(c));

      await registry.importCredential(conn.id, "user", fx.userCredential());
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

      // Re-authorize via importCredential (new material clears the flag + re-unlocks).
      const unlocksBeforeReauth = unlocks.length;
      await registry.importCredential(conn.id, "user", {
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

  // Scenario 8 — epoch handle death + fresh wrapper
  describe("scenario 8: epoch handle death + fresh wrapper", () => {
    it("revoke kills the captured wrapper; conn.talk is null; re-import yields a NEW wrapper; the OLD wrapper still throws", async () => {
      const ledger = makeLedger();
      const registry = new ConnectionRegistry({ ledger });
      const fx = makePasteTalk();
      registry.register(fx.descriptor);
      const conn = await registry.connect("fake-telegram");
      await registry.importCredential(conn.id, "bot", fx.validCredential());

      expect(conn.talk).not.toBeNull();
      const oldWrapper = conn.talk as Talk;
      // The wrapper works while its epoch is live.
      await oldWrapper.send("thread-1" as ConversationId, { text: "before revoke" });

      // Revoke the grant → epoch dies.
      await conn.auth.revoke("bot");
      expect(conn.talk).toBeNull();
      expect(conn.auth.grants().bot).toBe("unauthorized");

      // The captured wrapper now throws the relock error.
      await expect(
        oldWrapper.send("thread-1" as ConversationId, { text: "after revoke" }),
      ).rejects.toThrow(/relocked; re-acquire via onUnlocked/);
      expect(() => oldWrapper.subscribe(async () => {})).toThrow(
        /relocked; re-acquire via onUnlocked/,
      );

      // Re-import → conn.talk is a NEW live wrapper.
      await registry.importCredential(conn.id, "bot", fx.validCredential());
      expect(conn.talk).not.toBeNull();
      const newWrapper = conn.talk as Talk;
      await newWrapper.send("thread-1" as ConversationId, { text: "after reimport" });

      // The OLD wrapper still throws even though a new epoch exists.
      await expect(
        oldWrapper.send("thread-1" as ConversationId, { text: "still dead" }),
      ).rejects.toThrow(/relocked; re-acquire via onUnlocked/);
    });
  });

  // Late faults from a discarded epoch must not touch grant state: transports
  // fire terminal errors from in-flight work while teardown is still draining
  // (WeChat's poll 401 after stop, Baileys' loggedOut close). Acting on one
  // would flip a just-revoked grant unauthorized→degraded.
  describe("late fault after epoch discard", () => {
    it("a CredentialRejected fired by the OLD instance after revoke leaves the grant unauthorized", async () => {
      const ledger = makeLedger();
      const registry = new ConnectionRegistry({ ledger });
      const fx = makePasteTalk();
      registry.register(fx.descriptor);
      const conn = await registry.connect("fake-telegram");
      await registry.importCredential(conn.id, "bot", fx.validCredential());

      // Capture the OLD instance's fault callback, then revoke (epoch dies).
      const oldFault = fx.talkerFactory.instances[0].state.fault;
      expect(oldFault).not.toBeNull();
      await conn.auth.revoke("bot");
      expect(conn.auth.grants().bot).toBe("unauthorized");

      // The in-flight transport reports an auth failure AFTER the discard.
      oldFault!(new CredentialRejected({ grant: "bot" }));
      await new Promise((r) => setTimeout(r, 0)); // let any (wrong) async flow run

      expect(conn.auth.grants().bot).toBe("unauthorized");
      expect((await ledger.getGrant(conn.id, "bot"))?.state).toBe("unauthorized");
    });

    it("a late fault from a SUPERSEDED epoch does not renew or degrade the new epoch's grant", async () => {
      const ledger = makeLedger();
      const registry = new ConnectionRegistry({ ledger });
      const fx = makePasteTalk();
      registry.register(fx.descriptor);
      const conn = await registry.connect("fake-telegram");
      await registry.importCredential(conn.id, "bot", fx.validCredential());
      const oldFault = fx.talkerFactory.instances[0].state.fault;

      // New material → new epoch; the old instance was discarded.
      await registry.importCredential(conn.id, "bot", {
        material: { token: "rotated-token" },
        expiresAt: "never",
      });
      expect(conn.auth.grants().bot).toBe("authorized");

      oldFault!(new CredentialRejected({ grant: "bot" }));
      await new Promise((r) => setTimeout(r, 0));

      // Still authorized: the stale fault neither renewed nor degraded.
      expect(conn.auth.grants().bot).toBe("authorized");
      expect((await ledger.getGrant(conn.id, "bot"))?.state).toBe("authorized");
    });
  });

  // Scenario 9 — old instance stopped before new build (ordering)
  describe("scenario 9: stop-before-build ordering", () => {
    it("re-authorize stops the old instance before building the new one", async () => {
      const ledger = makeLedger();
      const registry = new ConnectionRegistry({ ledger });
      const fx = makePasteTalk();
      registry.register(fx.descriptor);
      const conn = await registry.connect("fake-telegram");

      // Record the global order of stop() vs build() across instances.
      const order: string[] = [];
      // Wrap the factory build so we log the build event and each instance's stop.
      const originalBuild = fx.descriptor.capabilities.talker?.build;
      if (!originalBuild) throw new Error("talker build missing");
      let buildIndex = 0;
      fx.descriptor.capabilities.talker!.build = (creds, kit) => {
        const idx = buildIndex++;
        order.push(`build:${idx}`);
        const instance = originalBuild(creds, kit);
        const originalStop = instance.stop.bind(instance);
        instance.stop = () => {
          order.push(`stop:${idx}`);
          originalStop();
        };
        return instance;
      };

      // First authorize builds instance 0.
      await registry.importCredential(conn.id, "bot", fx.validCredential());
      expect(order).toEqual(["build:0"]);

      // Re-authorize with DIFFERENT material → epoch rebuild: stop old, build new.
      await registry.importCredential(conn.id, "bot", {
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
    it("faults rebuild the SAME epoch with SAME material, wrapper survives, durations grow exponentially, grant untouched, no onUnlocked re-fire", async () => {
      const ledger = makeLedger();
      const sleep = makeRecordingSleep();
      const registry = new ConnectionRegistry({
        ledger,
        sleep: sleep.fn,
        backoff: { baseMs: 100, maxMs: 10_000 },
      });
      const fx = makePasteTalk();
      registry.register(fx.descriptor);
      const conn = await registry.connect("fake-telegram");

      const unlocks: Connection[] = [];
      registry.onUnlocked("talk", (c) => unlocks.push(c));

      await registry.importCredential(conn.id, "bot", fx.validCredential());
      expect(unlocks.length).toBe(1); // initial unlock only

      const wrapper = conn.talk as Talk;
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
      expect(instance1.state.starts[0]?.creds.bot.material).toEqual(
        instance0.state.starts[0]?.creds.bot.material,
      );
      // The public wrapper survives the backoff rebuild — send routes to the NEW
      // instance.
      await wrapper.send("thread-1" as ConversationId, { text: "after reconnect" });
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
      await wrapper.send("thread-1" as ConversationId, { text: "final" });
      expect(instance3.state.sends.map((s) => s.msg)).toContainEqual({ text: "final" });
    });

    it("a successful delivery between faults resets the backoff exponent", async () => {
      const ledger = makeLedger();
      const sleep = makeRecordingSleep();
      const registry = new ConnectionRegistry({
        ledger,
        sleep: sleep.fn,
        backoff: { baseMs: 100, maxMs: 10_000 },
      });
      const fx = makePasteTalk();
      registry.register(fx.descriptor);
      const conn = await registry.connect("fake-telegram");
      await registry.importCredential(conn.id, "bot", fx.validCredential());

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
        messageId: "m",
        conversationId: "thread-1" as ConversationId,
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
        ledger,
        sleep: sleep.fn,
        backoff: { baseMs: 1, maxMs: 1 },
      });

      // Capture the kit handed to build() so we can drive kit.persist directly.
      let capturedKit: import("./types.js").RuntimeKit | null = null;
      const fx = makePasteTalk();
      const originalBuild = fx.descriptor.capabilities.talker!.build;
      fx.descriptor.capabilities.talker = {
        ...fx.descriptor.capabilities.talker!,
        build(creds, kit) {
          capturedKit = kit;
          return originalBuild(creds, kit);
        },
      };
      registry.register(fx.descriptor);
      const conn = await registry.connect("fake-telegram");
      await registry.importCredential(conn.id, "bot", fx.validCredential());
      expect(capturedKit).not.toBeNull();

      const instance0 = fx.talkerFactory.instances.at(-1);
      if (!instance0) throw new Error("instance0 not built");

      // Write-through custody: rotate the material in place. No rebuild yet.
      await capturedKit!.persist("bot", { token: "rotated-token" });
      expect(fx.talkerFactory.instances.length).toBe(1); // no rebuild on persist

      // Now a Disconnected fault forces a backoff rebuild.
      instance0.state.fault?.(new Disconnected());
      await flush();

      const instance1 = fx.talkerFactory.instances.at(-1);
      if (!instance1) throw new Error("instance1 not built");
      expect(instance1).not.toBe(instance0);
      // The rebuilt instance must see the ROTATED material, not "fake-bot-token".
      expect(instance1.state.starts[0]?.creds.bot.material).toEqual({ token: "rotated-token" });
    });
  });

  // Scenario 11 — onUnlocked fires before the stream starts (first-delivery)
  describe("scenario 11: onUnlocked fires before start()", () => {
    it("a handler registered synchronously in onUnlocked catches a message the Talker delivers from start()", async () => {
      const ledger = makeLedger();
      const registry = new ConnectionRegistry({ ledger });
      const fx = makePasteTalk();
      // The Talker will synchronously flush one buffered inbound message the
      // instant its start() runs. Arm the flush on the fake talker the factory
      // produces (build() runs synchronously inside importCredential, before
      // start(), so the knob is set in time).
      const flushed = makeInboundMessage({
        messageId: "buffered-1",
        text: "buffered on start",
      });
      const originalBuild = fx.talkerFactory.build.bind(fx.talkerFactory);
      fx.talkerFactory.build = (creds) => {
        const t = originalBuild(creds);
        t.state.flushOnStart = [flushed];
        return t;
      };
      registry.register(fx.descriptor);
      const conn = await registry.connect("fake-telegram");

      // Register the unlock handler BEFORE the epoch is built. When talk unlocks,
      // the handler synchronously registers an onMessage listener — which must be
      // wired before start() runs, or the buffered flush is lost.
      const received: InboundMessage[] = [];
      registry.onUnlocked("talk", (c) => {
        c.talk?.subscribe(async (msg) => {
          received.push(msg);
        });
      });

      // Authorize → buildEpoch fires onUnlocked (handler registers) → start()
      // (flushes the buffered message into the now-wired handler).
      await registry.importCredential(conn.id, "bot", fx.validCredential());
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
// ledger writes), and a conferral completing in that window tears down the
// faulting epoch — the stale flow must become a no-op, never persist `degraded`
// (or a renewed credential) over the fresh grant.

describe("credential-rejected flow vs. a conferral completing mid-flow", () => {
  it("a re-login completing while the fault flow is parked in renew() cannot degrade the fresh grant", async () => {
    const ledger = makeLedger();
    const registry = new ConnectionRegistry({ ledger });
    const talkerFactory = makeFakeTalkerFactory();
    // A session-like scheme whose renew() parks on a test-controlled gate before
    // answering "re-confer" — the widest await in the fault flow.
    let releaseRenew!: () => void;
    const renewGate = new Promise<void>((resolve) => {
      releaseRenew = resolve;
    });
    let renewStarted = false;
    const descriptor: ConnectionDescriptor = {
      service: "fake-session-svc",
      auth: {
        session: {
          async confer(): Promise<Credential> {
            throw new Error("route-driven");
          },
          async renew(): Promise<Credential | "re-confer"> {
            renewStarted = true;
            await renewGate;
            return "re-confer";
          },
        },
      },
      capabilities: {
        talker: { needs: ["session"] as const, build: (creds) => talkerFactory.build(creds) },
      },
    };
    registry.register(descriptor);
    const conn = await registry.connect("fake-session-svc");
    await registry.importCredential(conn.id, "session", {
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
    await registry.importCredential(conn.id, "session", {
      material: { token: "tok-fresh" },
      expiresAt: "never",
    });
    expect(conn.auth.grants().session).toBe("authorized");
    const epochBTalker = talkerFactory.instances.at(-1);
    expect(epochBTalker).not.toBe(epochATalker);

    // The parked flow now resumes and answers "re-confer" — but its source epoch
    // is dead, so it must NOT persist `degraded` over the fresh conferral.
    releaseRenew();
    await flush();
    await flush();

    expect(conn.auth.grants().session).toBe("authorized");
    expect(conn.talk).not.toBeNull();
    const grant = await ledger.getGrant(conn.id, "session");
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
   *  conferral can complete INSIDE the fault flow's awaited ledger call. All
   *  other calls (including the conferral's own writes and any repair write)
   *  pass straight through. */
  function makeGatedLedger(
    inner: GrantLedger,
    shouldGate: (patch: Record<string, unknown>) => boolean,
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
        if (!gatedOnce && shouldGate(patch as Record<string, unknown>)) {
          gatedOnce = true;
          await gate;
        }
        return inner.updateGrant(custody, name, patch);
      },
    };
    return { ledger, release };
  }

  function makeSessionDescriptor(
    talkerFactory: ReturnType<typeof makeFakeTalkerFactory>,
    renew: () => Promise<Credential | "re-confer">,
  ): ConnectionDescriptor {
    return {
      service: "fake-session-svc",
      auth: {
        session: {
          async confer(): Promise<Credential> {
            throw new Error("route-driven");
          },
          renew,
        },
      },
      capabilities: {
        talker: { needs: ["session"] as const, build: (creds) => talkerFactory.build(creds) },
      },
    };
  }

  it("a re-login completing while the degrade LEDGER WRITE is in flight leaves the fresh grant and epoch intact", async () => {
    // Gate the degrade row write itself — the supersession window AFTER the
    // pre-write stillCurrent check passed.
    const { ledger, release } = makeGatedLedger(
      makeLedger(),
      (patch) => patch.state === "degraded",
    );
    const registry = new ConnectionRegistry({ ledger });
    const talkerFactory = makeFakeTalkerFactory();
    registry.register(makeSessionDescriptor(talkerFactory, async () => "re-confer"));
    const conn = await registry.connect("fake-session-svc");
    await registry.importCredential(conn.id, "session", {
      material: { token: "tok-old" },
      expiresAt: "never",
    });
    const epochATalker = talkerFactory.instances.at(-1);
    if (!epochATalker) throw new Error("epoch A talker not built");

    // Fault → renew answers "re-confer" → degradeGrant starts its ledger write
    // and parks inside it.
    epochATalker.state.fault?.(new CredentialRejected({ grant: "session" }));
    await flush();
    expect(conn.auth.grants().session).toBe("authorized"); // write parked, nothing applied

    // A re-login completes during the parked write.
    await registry.importCredential(conn.id, "session", {
      material: { token: "tok-fresh" },
      expiresAt: "never",
    });
    const epochBTalker = talkerFactory.instances.at(-1);
    expect(epochBTalker).not.toBe(epochATalker);

    // The parked degrade write now lands ON TOP of the conferral's row — the
    // flow must not apply it in memory, and must repair the row it clobbered.
    release();
    await flush();
    await flush();

    expect(conn.auth.grants().session).toBe("authorized");
    expect(conn.talk).not.toBeNull();
    expect(epochBTalker?.state.stopCount).toBe(0);
    const grant = await ledger.getGrant(conn.id, "session");
    expect(grant?.state).toBe("authorized");
    expect(grant?.degraded).toBeUndefined();
    expect(grant?.credential).toMatchObject({
      material: { kind: "inline", record: { token: "tok-fresh" } },
    });
  });

  it("a re-login completing while a SUCCESSFUL RENEWAL's ledger write is in flight is not overwritten by the stale renewal", async () => {
    // Gate the renewal row write (the only fault-path write with lastRenewedAt).
    const { ledger, release } = makeGatedLedger(
      makeLedger(),
      (patch) => patch.lastRenewedAt !== undefined,
    );
    const registry = new ConnectionRegistry({ ledger });
    const talkerFactory = makeFakeTalkerFactory();
    registry.register(
      makeSessionDescriptor(talkerFactory, async () => ({
        material: { token: "tok-renewed" },
        expiresAt: "never" as const,
      })),
    );
    const conn = await registry.connect("fake-session-svc");
    await registry.importCredential(conn.id, "session", {
      material: { token: "tok-old" },
      expiresAt: "never",
    });
    const epochATalker = talkerFactory.instances.at(-1);
    if (!epochATalker) throw new Error("epoch A talker not built");

    // Fault → renew succeeds → the authorized+renewed write parks.
    epochATalker.state.fault?.(new CredentialRejected({ grant: "session" }));
    await flush();

    // A re-login completes during the parked write.
    await registry.importCredential(conn.id, "session", {
      material: { token: "tok-fresh" },
      expiresAt: "never",
    });
    const epochBTalker = talkerFactory.instances.at(-1);
    expect(epochBTalker).not.toBe(epochATalker);
    const buildsAfterRelogin = talkerFactory.instances.length;

    // The stale renewal write lands on top of the conferral — the flow must not
    // swap the live credential to the stale renewal, rebuild the epoch, or leave
    // the stale credential in the row.
    release();
    await flush();
    await flush();

    expect(conn.auth.grants().session).toBe("authorized");
    expect(conn.talk).not.toBeNull();
    expect(epochBTalker?.state.stopCount).toBe(0);
    expect(talkerFactory.instances.length).toBe(buildsAfterRelogin); // no stale rebuild
    const grant = await ledger.getGrant(conn.id, "session");
    expect(grant?.state).toBe("authorized");
    expect(grant?.credential).toMatchObject({
      material: { kind: "inline", record: { token: "tok-fresh" } },
    });
  });
});
