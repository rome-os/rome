import { describe, expect, it } from "@rstest/core";
import type { DrizzleTx, SqliteExec } from "../db/index.js";
import { createTestDb } from "../test/helpers.js";
import { DrizzleGrantLedger } from "./ledger-db.js";
import { ConnectionRegistry } from "./registry.js";
import { makePasteTalk, makeZeroGrantTalk } from "./test-fixtures.js";
import type { ConnectionId } from "./types.js";

describe("ConnectionRegistry Service uniqueness", () => {
  it("rejects a second connection for a Service with an actionable error", async () => {
    const { db, close } = createTestDb();
    try {
      const ledger = new DrizzleGrantLedger(db);
      const registry = new ConnectionRegistry({ ledger });
      registry.register(makeZeroGrantTalk().descriptor);
      const existing = await registry.connect("fake-webchat");

      await expect(registry.connect("fake-webchat")).rejects.toThrow(
        new RegExp(`fake-webchat.*${existing.id}.*remove`, "i"),
      );
      await expect(ledger.listConnections()).resolves.toHaveLength(1);
    } finally {
      close();
    }
  });

  it("mints only one connection when two connects for a Service race", async () => {
    const { db, close } = createTestDb();
    try {
      const ledger = new DrizzleGrantLedger(db);
      const registry = new ConnectionRegistry({ ledger });
      registry.register(makeZeroGrantTalk().descriptor);

      const results = await Promise.allSettled([
        registry.connect("fake-webchat"),
        registry.connect("fake-webchat"),
      ]);

      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      const rejected = results.find((result) => result.status === "rejected");
      expect(rejected).toMatchObject({ status: "rejected" });
      expect(rejected?.status === "rejected" ? rejected.reason.message : "").toMatch(
        /mints only a Service's first connection/i,
      );
      await expect(ledger.listConnections()).resolves.toHaveLength(1);
    } finally {
      close();
    }
  });

  it("mints another connection when asked, alongside the first", async () => {
    const { db, close } = createTestDb();
    try {
      const ledger = new DrizzleGrantLedger(db);
      const registry = new ConnectionRegistry({ ledger });
      registry.register(makeZeroGrantTalk().descriptor);
      const first = await registry.connect("fake-webchat");
      const second = await registry.connectAnother("fake-webchat");

      expect(second.id).not.toBe(first.id);
      expect(registry.find("fake-webchat").map((connection) => connection.id)).toEqual([
        first.id,
        second.id,
      ]);
      await expect(ledger.listConnections()).resolves.toHaveLength(2);
    } finally {
      close();
    }
  });

  it("runs the mint participant in the mint transaction and rolls back with it", async () => {
    const { db, close } = createTestDb();
    try {
      const ledger = new DrizzleGrantLedger(db);
      const minted: string[] = [];
      let fail = true;
      const registry = new ConnectionRegistry({
        ledger,
        onMint: (_tx, record) => {
          if (fail) {
            fail = false;
            throw new Error("injected participant failure");
          }
          minted.push(record.service);
        },
      });
      registry.register(makePasteTalk().descriptor);

      await expect(registry.connect("fake-telegram")).rejects.toThrow(
        "injected participant failure",
      );
      await expect(ledger.listConnections()).resolves.toEqual([]);

      await registry.connect("fake-telegram");
      expect(minted).toEqual(["fake-telegram"]);
    } finally {
      close();
    }
  });

  it("runs the remove participant in the delete transaction", async () => {
    const { db, close } = createTestDb();
    try {
      const removed: string[] = [];
      const registry = new ConnectionRegistry({
        ledger: new DrizzleGrantLedger(db),
        onRemove: (_tx, id) => removed.push(id),
      });
      registry.register(makePasteTalk().descriptor);
      const connection = await registry.connect("fake-telegram");

      await registry.remove(connection.id);

      expect(removed).toEqual([connection.id]);
    } finally {
      close();
    }
  });

  it("rolls back the connection row when initial grant creation fails", async () => {
    const { db, close } = createTestDb();
    class FailingGrantInitLedger extends DrizzleGrantLedger {
      private failNextGrant = true;

      override writeEnsureGrant(exec: SqliteExec, custody: string, name: string): void {
        super.writeEnsureGrant(exec, custody, name);
        if (this.failNextGrant) {
          this.failNextGrant = false;
          throw new Error("injected initial grant failure");
        }
      }
    }

    try {
      const ledger = new FailingGrantInitLedger(db);
      const registry = new ConnectionRegistry({ ledger });
      registry.register(makePasteTalk().descriptor);

      await expect(registry.connect("fake-telegram")).rejects.toThrow(
        "injected initial grant failure",
      );
      await expect(ledger.listConnections()).resolves.toEqual([]);

      const retried = await registry.connect("fake-telegram");
      await expect(ledger.getGrant(retried.id, "bot")).resolves.toMatchObject({
        state: "unauthorized",
      });
    } finally {
      close();
    }
  });

  it("keeps a live connection registered when durable deletion fails so removal can retry", async () => {
    const { db, close } = createTestDb();
    class FailingDeleteLedger extends DrizzleGrantLedger {
      private failNextDelete = true;

      override async deleteConnection(
        id: ConnectionId,
        inTx?: (tx: DrizzleTx) => void,
      ): Promise<void> {
        if (this.failNextDelete) {
          this.failNextDelete = false;
          throw new Error("injected connection deletion failure");
        }
        await super.deleteConnection(id, inTx);
      }
    }

    try {
      const ledger = new FailingDeleteLedger(db);
      const fixture = makePasteTalk();
      const registry = new ConnectionRegistry({ ledger });
      registry.register(fixture.descriptor);
      const connection = await registry.connect("fake-telegram");
      await registry.importCredential(connection.id, "bot", fixture.validCredential());
      expect(connection.isUnlocked("talk")).toBe(true);

      await expect(registry.remove(connection.id)).rejects.toThrow(
        "injected connection deletion failure",
      );
      expect(registry.get(connection.id)).toBe(connection);
      expect(connection.isUnlocked("talk")).toBe(true);
      await expect(ledger.listConnections()).resolves.toHaveLength(1);

      await registry.remove(connection.id);
      expect(registry.all()).toEqual([]);
      await expect(ledger.listConnections()).resolves.toEqual([]);
    } finally {
      close();
    }
  });
});

describe("connections.service in a migrated store", () => {
  it("accepts several connections of one Service", async () => {
    const { db, close } = createTestDb();
    try {
      const ledger = new DrizzleGrantLedger(db);
      ledger.writeConnection(db, {
        id: "discord-a",
        service: "discord",
        label: "A",
        createdAt: new Date(1),
      });
      ledger.writeConnection(db, {
        id: "discord-b",
        service: "discord",
        label: "B",
        createdAt: new Date(2),
      });

      await expect(ledger.listConnections()).resolves.toHaveLength(2);
    } finally {
      close();
    }
  });

  it("lists a Service's connections oldest first, whatever order they were written", async () => {
    const { db, close } = createTestDb();
    try {
      const ledger = new DrizzleGrantLedger(db);
      ledger.writeConnection(db, {
        id: "later",
        service: "discord",
        label: "B",
        createdAt: new Date(2_000),
      });
      ledger.writeConnection(db, {
        id: "first",
        service: "discord",
        label: "A",
        createdAt: new Date(1_000),
      });

      const ids = (await ledger.listConnections()).map((record) => record.id);
      expect(ids).toEqual(["first", "later"]);
    } finally {
      close();
    }
  });

  it("keeps write order for connections minted in the same second", async () => {
    const { db, close } = createTestDb();
    try {
      const ledger = new DrizzleGrantLedger(db);
      ledger.writeConnection(db, {
        id: "zzz-first",
        service: "discord",
        label: "A",
        createdAt: new Date(1_000),
      });
      ledger.writeConnection(db, {
        id: "aaa-later",
        service: "discord",
        label: "B",
        createdAt: new Date(1_500),
      });

      const ids = (await ledger.listConnections()).map((record) => record.id);
      expect(ids).toEqual(["zzz-first", "aaa-later"]);
    } finally {
      close();
    }
  });
});
