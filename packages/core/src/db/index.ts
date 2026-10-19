import { mkdirSync } from "fs";
import { dirname } from "path";
import { drizzle as drizzleSqlite, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";
import Database from "better-sqlite3";
import pg from "pg";
import { getDefaultSqlitePath } from "../paths.js";

export const DEFAULT_SQLITE_PATH = getDefaultSqlitePath();

export interface DatabaseConfig {
  type: "sqlite" | "postgresql";
  sqlitePath?: string;
  postgresConnectionString?: string;
}

// Keep the shared connection minimally typed so app packages can bind their
// own table definitions instead of relying on a global schema barrel.
export type DrizzleDb = BetterSQLite3Database<Record<string, never>>;

// A transaction handle yielded by `db.transaction(...)` — the synchronous
// better-sqlite3 transaction scope. Derived from `DrizzleDb` so it tracks the
// driver.
export type DrizzleTx = Parameters<Parameters<DrizzleDb["transaction"]>[0]>[0];

// A synchronous write target: the db itself (autocommit) or a transaction on it.
// A write helper that takes one of these runs standalone OR enlisted in a
// caller's transaction with no change to its body — the terminal conferral uses
// this to write the credential, the placeholder connection, and the guardian
// mapping through one `tx`, while the same helpers back the plain async methods
// via `this.db`. `.run()` is the synchronous terminal, so this is better-sqlite3
// only by construction.
export type SqliteExec = Pick<DrizzleDb, "insert" | "update" | "delete">;

/** Whether a transaction is open on `db`'s connection. `drizzle()` attaches
 *  the better-sqlite3 client as `$client`, which `DrizzleDb` does not type. */
export function inTransaction(db: DrizzleDb): boolean {
  return (db as DrizzleDb & { $client: Database.Database }).$client.inTransaction;
}

export function createDb(config: DatabaseConfig): DrizzleDb {
  if (config.type === "sqlite") {
    const sqlitePath = config.sqlitePath ?? DEFAULT_SQLITE_PATH;
    mkdirSync(dirname(sqlitePath), { recursive: true });
    const sqlite = new Database(sqlitePath);
    sqlite.pragma("journal_mode = WAL");
    sqlite.pragma("foreign_keys = ON");
    return drizzleSqlite(sqlite);
  }

  if (config.type === "postgresql") {
    if (!config.postgresConnectionString) {
      throw new Error("postgresConnectionString is required for PostgreSQL connections");
    }
    const pool = new pg.Pool({
      connectionString: config.postgresConnectionString,
    });
    // Cast: PG drizzle instance is API-compatible at runtime for our use cases.
    // A full dual-dialect setup would require separate schema files per dialect.
    return drizzlePg(pool) as unknown as DrizzleDb;
  }

  throw new Error(`Unsupported database type: ${config.type}`);
}

let dbInstance: DrizzleDb | undefined;

export function getDb(config?: DatabaseConfig): DrizzleDb {
  if (dbInstance) return dbInstance;

  if (!config) {
    const type = (process.env.DATABASE_TYPE as "sqlite" | "postgresql") ?? "sqlite";
    config = {
      type,
      sqlitePath: process.env.SQLITE_PATH ?? DEFAULT_SQLITE_PATH,
      postgresConnectionString: process.env.DB_POSTGRES_URL,
    };
  }

  dbInstance = createDb(config);
  return dbInstance;
}

export function resetDb(): void {
  dbInstance = undefined;
}
