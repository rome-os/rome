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
import { removeUnconnectedAccounts } from "./unconnected-accounts.js";

const openDbs: Array<() => void> = [];
afterEach(() => {
  while (openDbs.length) openDbs.pop()?.();
});
function makeLedger(): DrizzleGrantLedger {
  const { db, close } = createTestDb();
  openDbs.push(close);
  return new DrizzleGrantLedger(db);
}

describe("removeUnconnectedAccounts", () => {
  it("removes an account that was never connected, and one that was disconnected", async () => {
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

    const removed = await removeUnconnectedAccounts(registry);

    expect(removed.sort()).toEqual([neverConnected.id, disconnected.id].sort());
    expect(registry.find("fake-telegram").map((conn) => conn.id)).toEqual([connected.id]);
    expect((await ledger.listConnections()).map((record) => record.id)).toEqual([connected.id]);
  });

  it("keeps a Connection whose service names no account", async () => {
    const registry = new ConnectionRegistry({ ledger: makeLedger() });
    const { accountIdOf: _unnamed, ...descriptor } = makePasteTalk().descriptor;
    registry.register(descriptor);
    await registry.connect("fake-telegram");

    expect(await removeUnconnectedAccounts(registry)).toEqual([]);
    expect(registry.find("fake-telegram")).toHaveLength(1);
  });

  it("keeps an account while any of its grants is held", async () => {
    const registry = new ConnectionRegistry({ ledger: makeLedger() });
    const discord = makeTwoGrant();
    // Named accounts, so only the held grant keeps it.
    registry.register({ ...discord.descriptor, accountIdOf: () => "account-1" });
    const conn = await registry.connect("fake-discord");
    await registry.importCredential(conn.id, "user", discord.userCredential());

    expect(await removeUnconnectedAccounts(registry)).toEqual([]);
    expect(registry.find("fake-discord")).toHaveLength(1);
  });

  it("keeps a channel that needs no grant, and a connection outside chats", async () => {
    const registry = new ConnectionRegistry({ ledger: makeLedger() });
    registry.register(makeZeroGrantTalk().descriptor);
    registry.register(makeRenewableAct().descriptor);
    const zeroGrant = await registry.connect(makeZeroGrantTalk().descriptor.connectionKind);
    await registry.connect("fake-github");

    expect(await removeUnconnectedAccounts(registry)).toEqual([]);
    expect(registry.all().map((conn) => conn.id)).toContain(zeroGrant.id);
    expect(registry.find("fake-github")).toHaveLength(1);
  });

  it("keeps an account it cannot remove, and removes the rest", async () => {
    const registry = new ConnectionRegistry({ ledger: makeLedger() });
    const telegram = makePasteTalk();
    registry.register({ ...telegram.descriptor, severalAccounts: true });
    const stuck = await registry.connectAnother("fake-telegram");
    const other = await registry.connectAnother("fake-telegram");
    const failing: Parameters<typeof removeUnconnectedAccounts>[0] = {
      all: () => registry.all(),
      getDescriptor: (service) => registry.getDescriptor(service),
      getLedger: () => registry.getLedger(),
      remove: (id, opts) => {
        if (id === stuck.id) return Promise.reject(new Error("ledger unavailable"));
        return registry.remove(id, opts);
      },
    };

    expect(await removeUnconnectedAccounts(failing)).toEqual([other.id]);
    expect(registry.find("fake-telegram").map((conn) => conn.id)).toEqual([stuck.id]);
  });
});
