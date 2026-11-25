import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { createDb, type DrizzleDb } from "./index.js";

describe("createDb transactions", () => {
  let dir: string;
  let db: DrizzleDb;
  let other: Database.Database;

  // Two connections to one file-backed WAL database, as Rome's main process
  // and an action worker hold. `other` gives up at once on a held lock, so a
  // competing write fails instead of blocking this thread.
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "db-transactions-"));
    const file = join(dir, "rome.db");
    db = createDb({ type: "sqlite", sqlitePath: file });
    db.run(sql`CREATE TABLE notes (id INTEGER PRIMARY KEY)`);
    other = new Database(file, { timeout: 0 });
  });

  afterEach(() => {
    other.close();
    (db as DrizzleDb & { $client: Database.Database }).$client.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const count = () => (other.prepare("SELECT count(*) AS n FROM notes").get() as { n: number }).n;

  it("lets a read-then-write transaction commit while another connection tries to write", () => {
    db.transaction((tx) => {
      tx.all(sql`SELECT id FROM notes`);
      expect(() => other.prepare("INSERT INTO notes (id) VALUES (2)").run()).toThrow(
        "database is locked",
      );
      tx.run(sql`INSERT INTO notes (id) VALUES (1)`);
    });

    expect(count()).toBe(1);
  });

  it("keeps a behavior the caller asks for", () => {
    let failure: unknown;
    try {
      db.transaction(
        (tx) => {
          tx.all(sql`SELECT id FROM notes`);
          other.prepare("INSERT INTO notes (id) VALUES (2)").run();
          tx.run(sql`INSERT INTO notes (id) VALUES (1)`);
        },
        { behavior: "deferred" },
      );
    } catch (err) {
      failure = err;
    }

    // Drizzle wraps the driver's error, so the SQLite code is on the cause.
    expect((failure as Error | undefined)?.cause).toMatchObject({ code: "SQLITE_BUSY_SNAPSHOT" });
    expect(count()).toBe(1);
  });
});
