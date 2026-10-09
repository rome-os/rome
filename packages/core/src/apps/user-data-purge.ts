/**
 * Daemon-internal "purge app user data" primitive.
 *
 * Single source of truth for what `purge=true` on uninstall means.
 *
 *   1. App-owned DB tables — every `<tablePrefix>__*` table, plus
 *      `appMigrationsTableName(tablePrefix)`. Dropped inside a
 *      transaction so a mid-drop failure rolls back.
 *   2. App-local data dir — `<appsRoot>/data/<appId>/`, conventionally
 *      `~/.rome/<profile>/apps/data/<appId>/` via `getProfileAppDataDir`.
 *
 * `tablePrefix` can be `null` — for apps without a `db:` block, the
 * caller can't and shouldn't drop tables. The data-dir rm still runs.
 * Sourcing the prefix is `resolveTablePrefixForPurge`'s job.
 */
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import type { AppCatalog } from "./catalog.js";
import { isResolvedApp, type ResolvedApp } from "./state.js";
import type { DrizzleDb } from "../db/index.js";
import { createLogger } from "../logger.js";
import { getProfileAppDataDir, getProfileAppsDir } from "../paths.js";
import {
  TABLE_PREFIX_PATTERN,
  appIdToPathSegment,
  appMigrationsTableName,
  isValidAppId,
  parseManifestObject,
} from "./packaging/index.js";

const log = createLogger("apps-purge");

function assertSafeAppId(appId: string): void {
  if (!isValidAppId(appId)) {
    throw new Error(`Refusing to purge unsafe appId ${JSON.stringify(appId)}`);
  }
}

export interface PurgeAppUserDataDeps {
  appId: string;
  tablePrefix: string | null;
  db: DrizzleDb;
  appsRoot?: string;
}

export interface PurgeAppUserDataResult {
  appId: string;
  dataDir: string;
  tablesDropped: string[];
  migrationsTableDropped: boolean;
}

export async function purgeAppUserData(
  deps: PurgeAppUserDataDeps,
): Promise<PurgeAppUserDataResult> {
  assertSafeAppId(deps.appId);

  const tablesDropped: string[] = [];
  let migrationsTableDropped = false;

  if (deps.tablePrefix !== null) {
    if (!TABLE_PREFIX_PATTERN.test(deps.tablePrefix)) {
      throw new Error(
        `purgeAppUserData("${deps.appId}"): refusing to purge with unsafe tablePrefix ${JSON.stringify(
          deps.tablePrefix,
        )}`,
      );
    }
    const prefix = deps.tablePrefix;
    const migrationsTable = appMigrationsTableName(prefix);
    const rows = (await deps.db.all(
      sql`SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE ${`${prefix}__%`} OR name = ${migrationsTable})`,
    )) as Array<{ name: string }>;

    deps.db.transaction((tx) => {
      for (const row of rows) {
        if (row.name === migrationsTable) {
          tx.run(sql.raw(`DROP TABLE IF EXISTS "${row.name}"`));
          migrationsTableDropped = true;
          continue;
        }
        if (!row.name.startsWith(`${prefix}__`)) continue;
        tx.run(sql.raw(`DROP TABLE IF EXISTS "${row.name}"`));
        tablesDropped.push(row.name);
      }
    });
  }

  const dataDir =
    deps.appsRoot != null
      ? join(deps.appsRoot, "data", appIdToPathSegment(deps.appId))
      : getProfileAppDataDir(deps.appId);
  await rm(dataDir, { recursive: true, force: true });

  log.info("purged app user data", {
    appId: deps.appId,
    tablePrefix: deps.tablePrefix,
    tablesDropped: tablesDropped.length,
    migrationsTableDropped,
    dataDir,
  });

  return {
    appId: deps.appId,
    dataDir,
    tablesDropped,
    migrationsTableDropped,
  };
}

export interface ResolveTablePrefixForPurgeOptions {
  appId: string;
  appsRoot?: string;
  /** Live catalog. Omit if not running inside the daemon. */
  catalog?: AppCatalog;
}

/**
 * Pick the right `tablePrefix` for an uninstall purge=true call.
 *
 *   1. Live catalog — the resolved view holds the same `tablePrefix` the
 *      installer wrote tables under.
 *   2. (No fallback) — orphan apps without a catalog entry skip table drop.
 */
export async function resolveTablePrefixForPurge(
  options: ResolveTablePrefixForPurgeOptions,
): Promise<string | null> {
  const view = options.catalog?.get(options.appId);
  if (!isResolvedApp(view)) return null;
  const resolved = view as ResolvedApp;
  if (resolved.db) return resolved.db.tablePrefix;
  // App has no db: block — nothing to purge at the table level.
  return null;
}

export async function readTablePrefixFromManifest(
  manifestPath: string,
  appId: string,
): Promise<string | null> {
  const obj = await parseManifestObject(manifestPath);
  const db = obj.db as { tablePrefix?: unknown } | undefined;
  if (!db) return null;
  if (db.tablePrefix == null) return appId;
  if (typeof db.tablePrefix !== "string") {
    throw new Error(
      `Invalid db.tablePrefix in ${manifestPath}: expected string, got ${typeof db.tablePrefix}`,
    );
  }
  return db.tablePrefix;
}

// Suppress unused import warning while keeping it available for callers.
export { getProfileAppsDir };
