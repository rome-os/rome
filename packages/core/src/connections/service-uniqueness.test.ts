import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { describe, expect, it } from "@rstest/core";
import type { SqliteExec } from "../db/index.js";
import { createTestDb } from "../test/helpers.js";
import { DrizzleGrantLedger } from "./ledger-db.js";
import type { ConnectionRecord, GrantLedger } from "./ledger.js";
import { ConnectionRegistry } from "./registry.js";
import { makePasteTalk, makeZeroGrantTalk } from "./test-fixtures.js";

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

  it("serializes concurrent creation attempts so only one connection is minted", async () => {
    const records: ConnectionRecord[] = [];
    const ledger = {
      createConnection: async (record) => {
        await Promise.resolve();
        records.push(record);
      },
      listConnections: async () => records,
      deleteConnection: async () => {},
      ensureGrant: async () => {},
      getGrant: async () => null,
      listGrants: async () => [],
      updateGrant: async () => {},
    } satisfies GrantLedger;
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
      /exactly one connection per Service/i,
    );
    expect(records).toHaveLength(1);
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
    try {
      const inner = new DrizzleGrantLedger(db);
      let failNextDelete = true;
      const ledger = {
        createConnection: (record) => inner.createConnection(record),
        listConnections: () => inner.listConnections(),
        async deleteConnection(id) {
          if (failNextDelete) {
            failNextDelete = false;
            throw new Error("injected connection deletion failure");
          }
          await inner.deleteConnection(id);
        },
        ensureGrant: (custody, name) => inner.ensureGrant(custody, name),
        getGrant: (custody, name) => inner.getGrant(custody, name),
        listGrants: (custody) => inner.listGrants(custody),
        updateGrant: (custody, name, patch) => inner.updateGrant(custody, name, patch),
      } satisfies GrantLedger;
      const fixture = makePasteTalk();
      const registry = new ConnectionRegistry({ ledger });
      registry.register(fixture.descriptor);
      const connection = await registry.connect("fake-telegram");
      await registry.importCredential(connection.id, "bot", fixture.validCredential());
      expect(connection.talk).not.toBeNull();

      await expect(registry.remove(connection.id)).rejects.toThrow(
        "injected connection deletion failure",
      );
      expect(registry.get(connection.id)).toBe(connection);
      expect(connection.talk).not.toBeNull();
      await expect(inner.listConnections()).resolves.toHaveLength(1);

      await registry.remove(connection.id);
      expect(registry.all()).toEqual([]);
      await expect(inner.listConnections()).resolves.toEqual([]);
    } finally {
      close();
    }
  });
});

/** Locate the migration that creates the `connections_service_unique` index by
 *  walking the journal's registered migrations and matching on SQL content,
 *  rather than hard-coding a filename. A merge can renumber the migration
 *  (0047 → 0049 → …); a hard-coded path would then silently `ENOENT` and turn
 *  these tests into no-ops. Tying resolution to the journal + the actual index
 *  statement keeps the test bound to the real migration wherever it lands. */
function resolveUniqueServiceConnectionsMigration(systemMigrationsDir: string): string {
  const journal = JSON.parse(
    readFileSync(resolve(systemMigrationsDir, "meta/_journal.json"), "utf8"),
  ) as { entries: { tag: string }[] };
  const matches = journal.entries
    .map((entry) => resolve(systemMigrationsDir, `${entry.tag}.sql`))
    .filter((path) => readFileSync(path, "utf8").includes("connections_service_unique"));
  if (matches.length !== 1) {
    throw new Error(
      `expected exactly one system migration creating connections_service_unique, found ${matches.length}`,
    );
  }
  return matches[0];
}

describe("connections.service database invariant", () => {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const migrationPath = resolveUniqueServiceConnectionsMigration(
    resolve(__dirname, "../../drizzle/system"),
  );

  function legacyDb(): Database.Database {
    const sqlite = new Database(":memory:");
    sqlite.exec(`
      CREATE TABLE connections (
        id text PRIMARY KEY NOT NULL,
        service text NOT NULL,
        label text NOT NULL,
        created_at integer NOT NULL
      );
    `);
    return sqlite;
  }

  function applyMigration(sqlite: Database.Database): void {
    const sql = readFileSync(migrationPath, "utf8").replaceAll("--> statement-breakpoint", "");
    sqlite.exec(sql);
  }

  it("migrates a clean store and prevents a later duplicate", () => {
    const sqlite = legacyDb();
    try {
      sqlite
        .prepare("INSERT INTO connections VALUES (?, ?, ?, ?)")
        .run("discord-a", "discord", "Discord", 1);
      applyMigration(sqlite);

      expect(() =>
        sqlite
          .prepare("INSERT INTO connections VALUES (?, ?, ?, ?)")
          .run("discord-b", "discord", "Discord 2", 2),
      ).toThrow(/UNIQUE constraint failed: connections\.service/);
    } finally {
      sqlite.close();
    }
  });

  it("rejects the unique-index migration when pre-existing duplicates exist and leaves rows intact", () => {
    const sqlite = legacyDb();
    try {
      const insert = sqlite.prepare("INSERT INTO connections VALUES (?, ?, ?, ?)");
      insert.run("discord-a", "discord", "Discord A", 1);
      insert.run("discord-b", "discord", "Discord B", 2);

      // With the pre-migration preflight gone, the CREATE UNIQUE INDEX itself is
      // the backstop: it fails loudly on pre-existing duplicates and, because
      // index creation is atomic, leaves every row untouched for the operator to
      // resolve.
      expect(() => applyMigration(sqlite)).toThrow(
        /UNIQUE constraint failed: connections\.service/,
      );
      expect(sqlite.prepare("SELECT id FROM connections ORDER BY id").all()).toEqual([
        { id: "discord-a" },
        { id: "discord-b" },
      ]);
    } finally {
      sqlite.close();
    }
  });
});
