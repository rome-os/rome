import { afterEach, describe, expect, it } from "@rstest/core";
import { createTestDb } from "../test/helpers.js";
import { DrizzleConnectionsRepository } from "./repository-db.js";
import { ConnectionRegistry } from "./registry.js";
import { makePasteTalk, makeRenewableAct } from "./test-fixtures.js";
import { removeUnconnectedAccounts } from "./unconnected-accounts.js";

const openDbs: Array<() => void> = [];
afterEach(() => {
  while (openDbs.length) openDbs.pop()?.();
});
function makeLedger(): DrizzleConnectionsRepository {
  const { db, close } = createTestDb();
  openDbs.push(close);
  return new DrizzleConnectionsRepository(db);
}

describe("removeUnconnectedAccounts", () => {
  it("removes an account that was never connected, and one that was disconnected", async () => {
    const ledger = makeLedger();
    const registry = new ConnectionRegistry({ repository: ledger });
    const telegram = makePasteTalk();
    registry.register({ ...telegram.descriptor, severalAccounts: true });
    const connected = await registry.connect("fake-telegram");
    await registry.confer(
      connected.connectionKind,
      connected.id,
      "bot",
      telegram.validCredential(),
    );
    const neverConnected = await registry.connectAnother("fake-telegram");
    const disconnected = await registry.connectAnother("fake-telegram");
    await registry.confer(
      disconnected.connectionKind,
      disconnected.id,
      "bot",
      telegram.validCredential(),
    );
    await registry.revoke(disconnected.id, "bot");

    const removed = await removeUnconnectedAccounts(registry);

    expect(removed.sort()).toEqual([neverConnected.id, disconnected.id].sort());
    expect(registry.find("fake-telegram").map((conn) => conn.id)).toEqual([connected.id]);
    expect((await ledger.all()).map((record) => record.id)).toEqual([connected.id]);
  });

  it("removes a disconnected connection whose accounts take no agent", async () => {
    const registry = new ConnectionRegistry({ repository: makeLedger() });
    const { takesAgent: _noAgent, ...descriptor } = makePasteTalk().descriptor;
    registry.register(descriptor);
    const conn = await registry.connect("fake-telegram");

    expect(await removeUnconnectedAccounts(registry)).toEqual([conn.id]);
    expect(registry.find("fake-telegram")).toHaveLength(0);
  });

  it("removes a disconnected connection outside chats", async () => {
    const registry = new ConnectionRegistry({ repository: makeLedger() });
    registry.register(makeRenewableAct().descriptor);
    const conn = await registry.connect("fake-github");

    expect(await removeUnconnectedAccounts(registry)).toEqual([conn.id]);
    expect(registry.find("fake-github")).toHaveLength(0);
  });

  it("keeps an account it cannot remove, and removes the rest", async () => {
    const registry = new ConnectionRegistry({ repository: makeLedger() });
    const telegram = makePasteTalk();
    registry.register({ ...telegram.descriptor, severalAccounts: true });
    const stuck = await registry.connectAnother("fake-telegram");
    const other = await registry.connectAnother("fake-telegram");
    const failing: Parameters<typeof removeUnconnectedAccounts>[0] = {
      all: () => registry.all(),
      grantOf: (id) => registry.grantOf(id),
      remove: (id, opts) => {
        if (id === stuck.id) return Promise.reject(new Error("store unavailable"));
        return registry.remove(id, opts);
      },
    };

    expect(await removeUnconnectedAccounts(failing)).toEqual([other.id]);
    expect(registry.find("fake-telegram").map((conn) => conn.id)).toEqual([stuck.id]);
  });
});
