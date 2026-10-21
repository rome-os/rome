import { mkdirSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import Database from "better-sqlite3";
import { drizzle, BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema";

const DB_DIR = join(homedir(), ".rome-desktop");
const DB_PATH = join(DB_DIR, "rome-desktop.db");

/**
 * Resolve the better_sqlite3.node that scripts/rebuild-native.mjs places.
 * In dev: packages/desktop/native/better_sqlite3.node
 * In production: the unpacked app resources
 */
export function getNativeBindingPath(): string | undefined {
  const candidates = [
    // Dev mode: relative to the dist/main/ output
    join(__dirname, "..", "..", "native", "better_sqlite3.node"),
    // Production: unpacked resource
    join(process.resourcesPath ?? "", "native", "better_sqlite3.node"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return undefined;
}

let _db: BetterSQLite3Database<typeof schema> | null = null;

export function getDb(): BetterSQLite3Database<typeof schema> {
  if (!_db) {
    throw new Error("Database not initialized. Call initDatabase() first.");
  }
  return _db;
}

export function initDatabase(): void {
  if (_db) return;

  mkdirSync(DB_DIR, { recursive: true });

  const nativeBinding = getNativeBindingPath();
  const sqlite = new Database(DB_PATH, nativeBinding ? { nativeBinding } : {});
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");

  // Drop legacy tables from removed features.
  sqlite.exec(`
    DROP TABLE IF EXISTS credentials;
    DROP TABLE IF EXISTS browser_sessions;
    DROP TABLE IF EXISTS browser_profiles;
    DROP TABLE IF EXISTS mcp_servers;
  `);

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  _db = drizzle(sqlite, { schema });
}
