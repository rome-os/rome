import type { DatabaseConfig, DrizzleDb } from "../db/index.js";
import { migrateAppByMetadata } from "../db/migrate.js";
import { createLogger } from "../logger.js";
import { type CatalogEvent, isResolvedApp, type SubscriberHandler } from "./state.js";

const log = createLogger("app-db-migration");

export interface AppDbMigrationSubscriberOptions {
  db: DrizzleDb;
  databaseConfig?: DatabaseConfig;
  /**
   * Invoked when drizzle migration throws for an app the catalog reports as
   * installed + enabled. Wires through to `AppManager.markBroken` so the
   * lockfile reflects the failed state.
   */
  markBroken: (appId: string, code: string, message: string) => Promise<void>;
}

/**
 * Catalog subscriber that applies an app's drizzle migrations whenever the
 * catalog resolves it as `installed && enabled` with a `db:` declaration.
 * Drizzle's migrator is idempotent — re-firing on cache-hit refreshes (boot,
 * set_enabled, re-install of the same hash) is a cheap no-op.
 *
 * Register BEFORE `appActionsSubscriber` so tables exist before any app
 * action instantiates against them.
 */
export function createAppDbMigrationSubscriber(
  opts: AppDbMigrationSubscriberOptions,
): SubscriberHandler {
  return async function appDbMigrationSubscriber(event: CatalogEvent) {
    if (event.change === "removed") return;
    const resolved = event.current;
    if (!isResolvedApp(resolved)) return;
    if (resolved.state !== "installed") return;
    if (!resolved.enabled) return;
    if (resolved.db == null) return;

    try {
      await migrateAppByMetadata(opts.db, resolved.db, opts.databaseConfig);
      log.debug("applied app db migrations", {
        appId: event.appId,
        migrationsTable: resolved.db.migrationsTable,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error("app db migration failed", { appId: event.appId, error: message });
      await opts.markBroken(event.appId, "MIGRATION_FAILED", message);
    }
  };
}
