import { readFileSync } from "fs";
import { join } from "path";
import { sql } from "drizzle-orm";
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

export interface RunMigrationsResult {
  /**
   * Applied system migrations dated after the newest one this build ships.
   * Nonzero means a newer release migrated the database and this build is a
   * rollback onto it. Always 0 on PostgreSQL, which the check does not cover.
   */
  databaseAheadBy: number;
}

const SYSTEM_MIGRATIONS_TABLE = "__drizzle_migrations_system";

/**
 * Runs the system migrations, then each app's. A database already ahead of
 * this build is logged as an error and reported in the result, never thrown:
 * the build may still boot on it, and the recovery is starting the newer
 * release again or restoring a copy of the database from before the upgrade.
 */
export async function runMigrations(
  config?: DatabaseConfig,
  options: RunMigrationsOptions = {},
): Promise<RunMigrationsResult> {
  const db = getDb(config);
  const migrate = pickMigrator(config);
  const migrationsFolder = getSystemMigrationsPath();

  const databaseAheadBy =
    config?.type === "postgresql" ? 0 : countSqliteMigrationsAheadOfBuild(db, migrationsFolder);

  await migrate(db as never, {
    migrationsFolder,
    migrationsTable: SYSTEM_MIGRATIONS_TABLE,
  });

  for (const meta of options.appDbMetadata ?? []) {
    await migrateAppByMetadata(db, meta, config);
  }
  return { databaseAheadBy };
}

// The drizzle migrator compares only the newest applied `created_at` with each
// migration's journal `when`, so a database ahead of the build is a silent
// no-op there. Counting the rows past this build's newest `when` makes the
// rollback visible before a missing table fails some later read.
function countSqliteMigrationsAheadOfBuild(db: DrizzleDb, migrationsFolder: string): number {
  try {
    const table = db.get<{ found: number } | undefined>(
      sql`SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ${SYSTEM_MIGRATIONS_TABLE}`,
    );
    if (!table) return 0;

    const journal = JSON.parse(
      readFileSync(join(migrationsFolder, "meta", "_journal.json"), "utf8"),
    ) as { entries: { when: number; tag: string }[] };
    const newest = journal.entries.reduce<{ when: number; tag: string } | undefined>(
      (latest, entry) => (!latest || entry.when > latest.when ? entry : latest),
      undefined,
    );
    if (!newest) return 0;

    const ahead =
      db.get<{ count: number }>(
        sql`SELECT count(*) AS count FROM ${sql.identifier(SYSTEM_MIGRATIONS_TABLE)} WHERE created_at > ${newest.when}`,
      )?.count ?? 0;
    if (ahead > 0) {
      log.error(
        "database was migrated by a newer Rome release; reads of anything it dropped will fail. Start the newer release again, or restore a copy of the database taken before the upgrade if you have one",
        { databaseAheadBy: ahead, newestKnownMigration: newest.tag },
      );
    }
    return ahead;
  } catch (err) {
    log.warn("could not compare the database's migrations with this build", {
      error: err instanceof Error ? err.message : String(err),
    });
    return 0;
  }
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
