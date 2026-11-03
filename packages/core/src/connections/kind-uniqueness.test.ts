import { describe, expect, it } from "@rstest/core";
import type { SqliteExec } from "../db/index.js";
import { createTestDb } from "../test/helpers.js";
import { NO_GRANT } from "./grant.js";
import { DrizzleConnectionsRepository } from "./repository-db.js";
import type { StoredConnection } from "./repository.js";
import { ConnectionRegistry } from "./registry.js";
import { makePasteTalk, makeRenewableAct } from "./test-fixtures.js";
import type { ConnectionId } from "./types.js";

describe("ConnectionRegistry connection kind uniqueness", () => {
  it("rejects a second connection for a connection kind with an actionable error", async () => {
    const { db, close } = createTestDb();
    try {
      const ledger = new DrizzleConnectionsRepository(db);
      const registry = new ConnectionRegistry({ repository: ledger });
      registry.register(makeRenewableAct().descriptor);
      const existing = await registry.connect("fake-github");

      await expect(registry.connect("fake-github")).rejects.toThrow(
        new RegExp(`fake-github.*${existing.id}.*remove`, "i"),
      );
      await expect(ledger.all()).resolves.toHaveLength(1);
    } finally {
      close();
    }
  });

  it("mints only one connection when two connects for a connection kind race", async () => {
    const { db, close } = createTestDb();
    try {
      const ledger = new DrizzleConnectionsRepository(db);
      const registry = new ConnectionRegistry({ repository: ledger });
      registry.register(makeRenewableAct().descriptor);

      const results = await Promise.allSettled([
        registry.connect("fake-github"),
        registry.connect("fake-github"),
      ]);

      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      const rejected = results.find((result) => result.status === "rejected");
      expect(rejected).toMatchObject({ status: "rejected" });
      expect(rejected?.status === "rejected" ? rejected.reason.message : "").toMatch(
        /mints only a connection kind's first connection/i,
      );
      await expect(ledger.all()).resolves.toHaveLength(1);
    } finally {
      close();
    }
  });

  it("mints another connection when asked, alongside the first", async () => {
    const { db, close } = createTestDb();
    try {
      const ledger = new DrizzleConnectionsRepository(db);
      const registry = new ConnectionRegistry({ repository: ledger });
      registry.register(makeRenewableAct().descriptor);
      const first = await registry.connect("fake-github");
      const second = await registry.connectAnother("fake-github");

      expect(second.id).not.toBe(first.id);
      expect(registry.find("fake-github").map((connection) => connection.id)).toEqual([
        first.id,
        second.id,
      ]);
      await expect(ledger.all()).resolves.toHaveLength(2);
    } finally {
      close();
    }
  });

  it("raises connected in the mint transaction and rolls back with its subscriber", async () => {
    const { db, close } = createTestDb();
    try {
      const ledger = new DrizzleConnectionsRepository(db);
      const minted: string[] = [];
      let fail = true;
      const registry = new ConnectionRegistry({
        repository: ledger,
        onEvent: (_tx, event) => {
          if (event.kind !== "connected") return;
          const record = event.connection;
          if (fail) {
            fail = false;
            throw new Error("injected subscriber failure");
          }
          minted.push(record.connectionKind);
        },
      });
      registry.register(makePasteTalk().descriptor);

      await expect(registry.connect("fake-telegram")).rejects.toThrow(
        "injected subscriber failure",
      );
      await expect(ledger.all()).resolves.toEqual([]);

      await registry.connect("fake-telegram");
      expect(minted).toEqual(["fake-telegram"]);
    } finally {
      close();
    }
  });

  it("raises disconnected in the delete transaction", async () => {
    const { db, close } = createTestDb();
    try {
      const removed: string[] = [];
      const registry = new ConnectionRegistry({
        repository: new DrizzleConnectionsRepository(db),
        onEvent: (_tx, event) => {
          if (event.kind === "disconnected") removed.push(event.connection.id);
        },
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
    class FailingGrantInitLedger extends DrizzleConnectionsRepository {
      private failNextGrant = true;

      override save(exec: SqliteExec, connection: StoredConnection): void {
        super.save(exec, connection);
        if (this.failNextGrant) {
          this.failNextGrant = false;
          throw new Error("injected initial grant failure");
        }
      }
    }

    try {
      const ledger = new FailingGrantInitLedger(db);
      const registry = new ConnectionRegistry({ repository: ledger });
      registry.register(makePasteTalk().descriptor);

      await expect(registry.connect("fake-telegram")).rejects.toThrow(
        "injected initial grant failure",
      );
      await expect(ledger.all()).resolves.toEqual([]);

      const retried = await registry.connect("fake-telegram");
      await expect(ledger.grantOf(retried.id)).resolves.toMatchObject({
        state: "unauthorized",
      });
    } finally {
      close();
    }
  });

  it("keeps a live connection registered when durable deletion fails so removal can retry", async () => {
    const { db, close } = createTestDb();
    class FailingDeleteLedger extends DrizzleConnectionsRepository {
      private failNextDelete = true;

      override remove(exec: SqliteExec, id: ConnectionId): void {
        if (this.failNextDelete) {
          this.failNextDelete = false;
          throw new Error("injected connection deletion failure");
        }
        super.remove(exec, id);
      }
    }

    try {
      const ledger = new FailingDeleteLedger(db);
      const fixture = makePasteTalk();
      const registry = new ConnectionRegistry({ repository: ledger });
      registry.register(fixture.descriptor);
      const connection = await registry.connect("fake-telegram");
      await registry.giveGrant(
        connection.connectionKind,
        connection.id,
        "bot",
        fixture.validCredential(),
      );
      expect(connection.isUnlocked("chat")).toBe(true);

      await expect(registry.remove(connection.id)).rejects.toThrow(
        "injected connection deletion failure",
      );
      expect(registry.get(connection.id)).toBe(connection);
      expect(connection.isUnlocked("chat")).toBe(true);
      await expect(ledger.all()).resolves.toHaveLength(1);

      await registry.remove(connection.id);
      expect(registry.all()).toEqual([]);
      await expect(ledger.all()).resolves.toEqual([]);
    } finally {
      close();
    }
  });
});

describe("connections.connection_kind column in a migrated store", () => {
  it("accepts several connections of one connection kind", async () => {
    const { db, close } = createTestDb();
    try {
      const ledger = new DrizzleConnectionsRepository(db);
      ledger.save(db, {
        id: "discord-a",
        connectionKind: "discord",
        label: "A",
        createdAt: new Date(1),
        grant: NO_GRANT,
      });
      ledger.save(db, {
        id: "discord-b",
        connectionKind: "discord",
        label: "B",
        createdAt: new Date(2),
        grant: NO_GRANT,
      });

      await expect(ledger.all()).resolves.toHaveLength(2);
    } finally {
      close();
    }
  });

  it("lists a connection kind's connections oldest first, whatever order they were written", async () => {
    const { db, close } = createTestDb();
    try {
      const ledger = new DrizzleConnectionsRepository(db);
      ledger.save(db, {
        id: "later",
        connectionKind: "discord",
        label: "B",
        createdAt: new Date(2_000),
        grant: NO_GRANT,
      });
      ledger.save(db, {
        id: "first",
        connectionKind: "discord",
        label: "A",
        createdAt: new Date(1_000),
        grant: NO_GRANT,
      });

      const ids = (await ledger.all()).map((record) => record.id);
      expect(ids).toEqual(["first", "later"]);
    } finally {
      close();
    }
  });

  it("keeps write order for connections minted in the same second", async () => {
    const { db, close } = createTestDb();
    try {
      const ledger = new DrizzleConnectionsRepository(db);
      ledger.save(db, {
        id: "zzz-first",
        connectionKind: "discord",
        label: "A",
        createdAt: new Date(1_000),
        grant: NO_GRANT,
      });
      ledger.save(db, {
        id: "aaa-later",
        connectionKind: "discord",
        label: "B",
        createdAt: new Date(1_500),
        grant: NO_GRANT,
      });

      const ids = (await ledger.all()).map((record) => record.id);
      expect(ids).toEqual(["zzz-first", "aaa-later"]);
    } finally {
      close();
    }
  });
});
