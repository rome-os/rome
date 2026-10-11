/**
 * An in-memory SQLite for the test kit and `rome run`, on Node's built-in
 * `node:sqlite`, so neither needs the native better-sqlite3 addon. It exposes
 * the better-sqlite3 surface that drizzle's better-sqlite3 session and app
 * code (`db.connection.all(sql…)`) call, which the host's own database is.
 */
import { createRequire } from "node:module";
import type { DatabaseSync, SQLInputValue, StatementSync } from "node:sqlite";

type Params = SQLInputValue[];
type Row = Record<string, unknown>;

// better-sqlite3 hands blobs back as Buffers; node:sqlite as plain Uint8Arrays.
function toBufferValue(value: unknown): unknown {
  return value instanceof Uint8Array && !Buffer.isBuffer(value)
    ? Buffer.from(value.buffer, value.byteOffset, value.byteLength)
    : value;
}

// node:sqlite rows have a null prototype; better-sqlite3 rows are plain objects.
function toRow(row: unknown): unknown {
  if (Array.isArray(row)) return row.map(toBufferValue);
  if (row === undefined || row === null) return row;
  const out: Row = {};
  for (const [key, value] of Object.entries(row as Row)) out[key] = toBufferValue(value);
  return out;
}

class Statement {
  constructor(private readonly statement: StatementSync) {}

  /** Rows as arrays of column values, for this and later calls. */
  raw(toggle = true): this {
    this.statement.setReturnArrays(toggle);
    return this;
  }

  get reader(): boolean {
    return this.statement.columns().length > 0;
  }

  run(...params: Params): { changes: number; lastInsertRowid: number | bigint } {
    const result = this.statement.run(...params);
    return { changes: Number(result.changes), lastInsertRowid: result.lastInsertRowid };
  }

  get(...params: Params): unknown {
    return toRow(this.statement.get(...params));
  }

  all(...params: Params): unknown[] {
    return this.statement.all(...params).map(toRow);
  }

  *iterate(...params: Params): IterableIterator<unknown> {
    for (const row of this.statement.iterate(...params)) yield toRow(row);
  }
}

type Transaction<F extends (...args: never[]) => unknown> = F & {
  deferred: F;
  immediate: F;
  exclusive: F;
};

// better-sqlite3 refuses an async transaction body, since its statements would
// run after the commit. Refuse it here too, so a test fails where Rome would.
function syncResult<T>(result: T): T {
  if (typeof (result as { then?: unknown } | null)?.then === "function") {
    throw new TypeError("Transaction function cannot return a promise");
  }
  return result;
}

export class NodeSqliteDatabase {
  readonly #db: DatabaseSync;
  #savepoints = 0;

  constructor(path = ":memory:") {
    // Loaded on first use, so importing the kit prints no experimental warning.
    let sqlite: typeof import("node:sqlite") | undefined;
    try {
      sqlite = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
    } catch {}
    const db = sqlite ? new sqlite.DatabaseSync(path) : undefined;
    // `isTransaction` and `setReturnArrays` arrived in Node 22.16 and 24.
    if (
      !db ||
      typeof db.isTransaction !== "boolean" ||
      !("setReturnArrays" in sqlite!.StatementSync.prototype)
    ) {
      db?.close();
      throw new Error(
        `The test kit's in-memory database needs node:sqlite from Node 22.16 or later; this is Node ${process.versions.node}. Upgrade Node, or pass better-sqlite3's default export as the Database option.`,
      );
    }
    this.#db = db;
  }

  get inTransaction(): boolean {
    return this.#db.isTransaction;
  }

  get open(): boolean {
    return this.#db.isOpen;
  }

  prepare(sql: string): Statement {
    return new Statement(this.#db.prepare(sql));
  }

  exec(sql: string): this {
    this.#db.exec(sql);
    return this;
  }

  pragma(source: string, options: { simple?: boolean } = {}): unknown {
    const rows = this.prepare(`PRAGMA ${source}`).all() as Row[];
    return options.simple ? Object.values(rows[0] ?? {})[0] : rows;
  }

  /** better-sqlite3's `transaction(fn)`: a function that runs `fn` in a
   *  transaction, or in a savepoint when one is already open. */
  transaction<F extends (...args: never[]) => unknown>(fn: F): Transaction<F> {
    const wrap = (begin: string) =>
      ((...args: Parameters<F>) => {
        if (this.#db.isTransaction) {
          const name = `rome_sp${++this.#savepoints}`;
          this.#db.exec(`SAVEPOINT ${name}`);
          try {
            const result = syncResult(fn(...args));
            this.#db.exec(`RELEASE ${name}`);
            return result;
          } catch (err) {
            this.#db.exec(`ROLLBACK TO ${name}`);
            this.#db.exec(`RELEASE ${name}`);
            throw err;
          } finally {
            this.#savepoints--;
          }
        }
        this.#db.exec(begin);
        try {
          const result = syncResult(fn(...args));
          this.#db.exec("COMMIT");
          return result;
        } catch (err) {
          if (this.#db.isTransaction) this.#db.exec("ROLLBACK");
          throw err;
        }
      }) as F;
    return Object.assign(wrap("BEGIN"), {
      deferred: wrap("BEGIN DEFERRED"),
      immediate: wrap("BEGIN IMMEDIATE"),
      exclusive: wrap("BEGIN EXCLUSIVE"),
    });
  }

  close(): void {
    if (this.#db.isOpen) this.#db.close();
  }
}
