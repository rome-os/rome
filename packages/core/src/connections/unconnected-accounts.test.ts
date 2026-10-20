import { afterEach, describe, expect, it } from "@rstest/core";
import { createTestDb } from "../test/helpers.js";
import { DrizzleGrantLedger } from "./ledger-db.js";
import { ConnectionRegistry } from "./registry.js";
import {
  makePasteTalk,
  makeRenewableAct,
  makeTwoGrant,
  makeZeroGrantTalk,
} from "./test-fixtures.js";
import { removeNeverConnectedAccounts } from "./unconnected-accounts.js";

const openDbs: Array<() => void> = [];
afterEach(() => {
  while (openDbs.length) openDbs.pop()?.();
});
function makeLedger(): DrizzleGrantLedger {
  const { db, close } = createTestDb();
  openDbs.push(close);
  return new DrizzleGrantLedger(db);
}

describe("removeNeverConnectedAccounts", () => {
  it("removes an account that was never connected, and keeps one that was disconnected", async () => {
    const ledger = makeLedger();
    const registry = new ConnectionRegistry({ ledger });
    const telegram = makePasteTalk();
    registry.register({ ...telegram.descriptor, severalAccounts: true });
    const connected = await registry.connect("fake-telegram");
    await registry.importCredential(connected.id, "bot", telegram.validCredential());
    const neverConnected = await registry.connectAnother("fake-telegram");
    const disconnected = await registry.connectAnother("fake-telegram");
    await registry.importCredential(disconnected.id, "bot", telegram.validCredential());
    await registry.revoke(disconnected.id, "bot");

    const removed = await removeNeverConnectedAccounts(registry);

    expect(removed).toEqual([neverConnected.id]);
    const kept = [connected.id, disconnected.id].sort();
    expect(
      registry
        .find("fake-telegram")
        .map((conn) => conn.id)
        .sort(),
    ).toEqual(kept);
    expect((await ledger.listConnections()).map((record) => record.id).sort()).toEqual(kept);
  });

  it("keeps an account while any of its grants is held", async () => {
    const registry = new ConnectionRegistry({ ledger: makeLedger() });
    const discord = makeTwoGrant();
    registry.register(discord.descriptor);
    const conn = await registry.connect("fake-discord");
    await registry.importCredential(conn.id, "user", discord.userCredential());

    expect(await removeNeverConnectedAccounts(registry)).toEqual([]);
    expect(registry.find("fake-discord")).toHaveLength(1);
  });

  it("keeps a channel that needs no grant, and a connection outside chats", async () => {
    const registry = new ConnectionRegistry({ ledger: makeLedger() });
    registry.register(makeZeroGrantTalk().descriptor);
    registry.register(makeRenewableAct().descriptor);
    const zeroGrant = await registry.connect(makeZeroGrantTalk().descriptor.service);
    await registry.connect("fake-github");

    expect(await removeNeverConnectedAccounts(registry)).toEqual([]);
    expect(registry.all().map((conn) => conn.id)).toContain(zeroGrant.id);
    expect(registry.find("fake-github")).toHaveLength(1);
  });

  it("keeps an account it cannot remove, and removes the rest", async () => {
    const registry = new ConnectionRegistry({ ledger: makeLedger() });
    const telegram = makePasteTalk();
    registry.register({ ...telegram.descriptor, severalAccounts: true });
    const stuck = await registry.connectAnother("fake-telegram");
    const other = await registry.connectAnother("fake-telegram");
    const failing: Parameters<typeof removeNeverConnectedAccounts>[0] = {
      all: () => registry.all(),
      getDescriptor: (service) => registry.getDescriptor(service),
      getLedger: () => registry.getLedger(),
      remove: (id, opts) => {
        if (id === stuck.id) return Promise.reject(new Error("ledger unavailable"));
        return registry.remove(id, opts);
      },
    };

    expect(await removeNeverConnectedAccounts(failing)).toEqual([other.id]);
    expect(registry.find("fake-telegram").map((conn) => conn.id)).toEqual([stuck.id]);
  });
});
