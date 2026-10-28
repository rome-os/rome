import { join } from "path";
import type Database from "better-sqlite3";
import { migrate as migrateSqlite } from "drizzle-orm/better-sqlite3/migrator";
import { migrate as migratePg } from "drizzle-orm/node-postgres/migrator";
import type { ResolvedRomeAppDbMetadata } from "../apps/types.js";
import { getDb, type DatabaseConfig, type DrizzleDb } from "./index.js";
import { getCoreRoot } from "../paths.js";
import { createLogger } from "../logger.js";

const log = createLogger("db-migrate");

export function getSystemMigrationsPath(): string {
  return join(getCoreRoot(), "drizzle", "system");
}

export function isMigrateCliEntrypoint(argv = process.argv): boolean {
  const entrypoint = argv[1];
  return (
    entrypoint === "src/db/migrate.ts" ||
    entrypoint === "dist/db/migrate.js" ||
    entrypoint?.endsWith("/src/db/migrate.ts") ||
    entrypoint?.endsWith("/dist/db/migrate.js") ||
    false
  );
}

function pickMigrator(config?: DatabaseConfig) {
  return config?.type === "postgresql" ? migratePg : migrateSqlite;
}

export async function migrateAppByMetadata(
  db: DrizzleDb,
  resolvedDb: ResolvedRomeAppDbMetadata,
  config?: DatabaseConfig,
): Promise<void> {
  const migrate = pickMigrator(config);
  await migrate(db as never, {
    migrationsFolder: resolvedDb.migrationsPath,
    migrationsTable: resolvedDb.migrationsTable,
  });
}

export interface RunMigrationsOptions {
  /**
   * Pre-resolved DB metadata for each installed app. Caller is expected to
   * have already booted the AppCatalog; this function does NOT enumerate the
   * lockfile on its own.
   */
  appDbMetadata?: readonly ResolvedRomeAppDbMetadata[];
}

export async function runMigrations(
  config?: DatabaseConfig,
  options: RunMigrationsOptions = {},
): Promise<void> {
  const db = getDb(config);
  const migrate = pickMigrator(config);

  await migrate(db as never, {
    migrationsFolder: getSystemMigrationsPath(),
    migrationsTable: "__drizzle_migrations_system",
  });
  if (config?.type !== "postgresql") reportLinksMigration(db);

  for (const meta of options.appDbMetadata ?? []) {
    await migrateAppByMetadata(db, meta, config);
  }
}

/**
 * Log what the migration re-keying links by platform could not settle cleanly,
 * then drop its report: a link it dropped because its account became one
 * another person holds, and a `feishu` link it placed while Rome held both
 * Feishu and Lark apps. The report exists only on the start that ran it.
 */
export function reportLinksMigration(db: DrizzleDb): void {
  const sqlite = (db as DrizzleDb & { $client: Database.Database }).$client;
  const exists = sqlite
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '__links_migration_report'",
    )
    .get();
  if (!exists) return;
  const rows = sqlite.prepare("SELECT * FROM __links_migration_report").all() as Array<{
    what: "dropped" | "guessed";
    platform: string;
    account_id: string;
    key: string;
    person_id: string;
    kept_person_id: string | null;
  }>;
  for (const row of rows) {
    if (row.what === "dropped") {
      log.warn("links migration dropped a link: its account is now one another person holds", {
        platform: row.platform,
        accountId: row.account_id,
        storedUnder: row.key,
        droppedFrom: row.person_id,
        keptBy: row.kept_person_id,
      });
    } else {
      log.warn("links migration placed a Feishu link under feishu while Rome holds Lark apps too", {
        accountId: row.account_id,
        personId: row.person_id,
      });
    }
  }
  sqlite.exec("DROP TABLE __links_migration_report");
}

// CLI entry point: run with `pnpm --filter @rome/core db:migrate`.
if (isMigrateCliEntrypoint()) {
  try {
    await runMigrations();
    log.info("Migrations completed successfully");
    process.exit(0);
  } catch (err) {
    log.error("Migration failed", { error: err });
    process.exit(1);
  }
}
