import { describe, expect, it } from "@rstest/core";
import { NodeSqliteDatabase } from "./node-sqlite.js";

function open(): NodeSqliteDatabase {
  const db = new NodeSqliteDatabase();
  db.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT, blob BLOB)");
  return db;
}

describe("NodeSqliteDatabase", () => {
  it("returns rows the way better-sqlite3 does", () => {
    const db = open();
    const insert = db.prepare("INSERT INTO notes (body, blob) VALUES (?, ?)");

    expect(insert.run("hi", Buffer.from("ab"))).toEqual({ changes: 1, lastInsertRowid: 1 });
    const row = db.prepare("SELECT body, blob FROM notes").get() as Record<string, unknown>;
    expect(Object.getPrototypeOf(row)).toBe(Object.prototype);
    expect(Buffer.isBuffer(row.blob)).toBe(true);
    expect(db.prepare("SELECT id, body FROM notes").raw().all()).toEqual([[1, "hi"]]);
    expect(db.prepare("SELECT 1 AS one").reader).toBe(true);
    expect(insert.reader).toBe(false);
    expect(db.pragma("user_version", { simple: true })).toBe(0);
  });

  it("commits, rolls back, and nests transactions as savepoints", () => {
    const db = open();
    const add = (body: string) => db.prepare("INSERT INTO notes (body) VALUES (?)").run(body);
    const count = () => (db.prepare("SELECT count(*) AS n FROM notes").get() as { n: number }).n;

    db.transaction(() => add("kept"))();
    expect(() =>
      db
        .transaction(() => {
          add("dropped");
          throw new Error("boom");
        })
        .immediate(),
    ).toThrow("boom");
    db.transaction(() => {
      add("outer");
      expect(() =>
        db.transaction(() => {
          add("inner");
          throw new Error("inner");
        })(),
      ).toThrow("inner");
    })();

    expect(count()).toBe(2);
    expect(db.inTransaction).toBe(false);
  });

  it("refuses an async transaction body, as better-sqlite3 does", () => {
    const db = open();

    expect(() =>
      db.transaction(async () => {
        db.prepare("INSERT INTO notes (body) VALUES (?)").run("late");
      })(),
    ).toThrow("cannot return a promise");
    expect(db.inTransaction).toBe(false);
    // The body ran up to its first await; the rollback undoes that write.
    expect(db.prepare("SELECT count(*) AS n FROM notes").get()).toEqual({ n: 0 });
  });
});
