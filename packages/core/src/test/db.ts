// Database and lookup helpers for tests. A test file that imports only this
// module starts in about 0.4s, against about 1.2s for test/helpers.ts, which
// loads most of Rome. Keep what this module imports at runtime to the schema,
// the driver, and repositories with no app dependencies.

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import type { AccountLink } from "@rome/api-types/account-agents";
import type { ActionEngineRepositories } from "../apps/actions/engine.js";
import type { AccountLinkOf } from "../chats/connected-accounts/account-links.js";
import type { ChannelOf } from "../chats/connected-accounts/connection-ports.js";
import type { DrizzleDb } from "../db/index.js";
import { ActionExecutionsRepository } from "../db/repositories/action-executions.js";
import { ApprovalsRepository } from "../db/repositories/approvals.js";
import type { ConnectionKindOfChannel } from "../db/repositories/channel-records.js";
import { ExecutionJournalRepository } from "../db/repositories/execution-journal.js";
import * as schema from "../db/schema.js";

export interface TestDb {
  db: DrizzleDb;
  close: () => void;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const SYSTEM_MIGRATIONS_DIR = resolve(__dirname, "../../drizzle/system");

// Running the migrations costs ~11ms against ~0.15ms to deserialize their
// result, and a core run opens well over a thousand test databases.
let migratedImage: Buffer | undefined;

function migratedSystemImage(): Buffer {
  if (!migratedImage) {
    const sqlite = new Database(":memory:");
    migrate(drizzle(sqlite, { schema }), {
      migrationsFolder: SYSTEM_MIGRATIONS_DIR,
      migrationsTable: "__drizzle_migrations_system",
    });
    migratedImage = sqlite.serialize();
    sqlite.close();
  }
  return migratedImage;
}

/** The kinds of link the built-in descriptors declare, for tests that build a
 *  channel record without a registry. `connections/integrations/index.test.ts`
 *  keeps it in step with the descriptors. */
export const BUILTIN_ACCOUNT_LINKS: Readonly<Record<string, AccountLink>> = {
  feishu: "own_account",
  telegram: "own_account",
  discord: "own_account",
  slack_bot: "own_account",
  telegram_user: "delegate",
};

/** {@link BUILTIN_ACCOUNT_LINKS} as a lookup. */
export const testAccountLinkOf: AccountLinkOf = (kind) => BUILTIN_ACCOUNT_LINKS[kind] ?? null;

/** Maps every channel to itself. Valid only where no connection kind has a later channel. */
export const identityConnectionKindOf: ConnectionKindOfChannel = (channel) => channel;

/** Opens a private in-memory database at the latest system schema. Each call
 *  starts from the same freshly migrated state, unaffected by writes to any
 *  other instance. */
export function createTestDb(): TestDb {
  const sqlite = new Database(migratedSystemImage());
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");

  const db = drizzle(sqlite, { schema }) as unknown as DrizzleDb;

  return {
    db,
    close: () => sqlite.close(),
  };
}

/** Writes a database at the latest system schema to `path`, and returns a
 *  way to open further connections to it, as Rome's main process and its
 *  action workers each hold one. */
export function createTestDbFile(path: string): () => TestDb & { sqlite: Database.Database } {
  writeFileSync(path, migratedSystemImage());
  return () => {
    const sqlite = new Database(path);
    sqlite.pragma("journal_mode = WAL");
    sqlite.pragma("foreign_keys = ON");
    return {
      db: drizzle(sqlite, { schema }) as unknown as DrizzleDb,
      sqlite,
      close: () => sqlite.close(),
    };
  };
}

/** The repositories an `ActionEngine` records into, backed by `db` or a fresh test DB. */
export function createActionEngineRepos(
  db: DrizzleDb = createTestDb().db,
): ActionEngineRepositories {
  return {
    executions: new ActionExecutionsRepository(db),
    approvals: new ApprovalsRepository(db),
    journal: new ExecutionJournalRepository(db),
  };
}

// countingDb — a database that records how many passes are made over it

/**
 * `db` with every read counted, for a test that asserts how many times a store
 * was walked rather than what it answered.
 *
 * Only `all` is counted, which is the one verb a read-only SQL adapter uses.
 * Everything else — the inserts a test seeds with, the schema it seeds into —
 * passes through untouched and uncounted.
 */
export function countingDb(db: DrizzleDb): { db: DrizzleDb; passes: () => number } {
  let passes = 0;
  const counted = new Proxy(db, {
    get(target, property, receiver) {
      if (property !== "all") return Reflect.get(target, property, receiver);
      return (...args: Parameters<DrizzleDb["all"]>) => {
        passes += 1;
        return target.all(...args);
      };
    },
  });
  return { db: counted as DrizzleDb, passes: () => passes };
}

/** Every Connection backs the channel named after its connection kind, as when each
 *  connection kind holds one Connection. */
export const kindChannelOf: ChannelOf = (connection) => connection.connectionKind;
