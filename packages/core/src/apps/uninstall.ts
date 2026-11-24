import type { DrizzleDb } from "../db/index.js";
import type { AppCatalog } from "./catalog.js";
import type { AppManager, UninstallResult } from "./manager.js";
import { purgeAppUserData, resolveTablePrefixForPurge } from "./user-data-purge.js";

export interface UninstallAppDeps {
  manager: Pick<AppManager, "uninstall">;
  catalog: AppCatalog;
  db: DrizzleDb;
  /** Where app data lives, when not the profile's apps folder. */
  appsRoot?: string;
}

/**
 * Removes an installed app. With `purge`, its tables and data folder go too.
 * The manager's refusals, such as for a first-party app, throw
 * `AppManagerError`. An app that is not installed answers `alreadyAbsent`.
 */
export async function uninstallApp(
  deps: UninstallAppDeps,
  appId: string,
  options: { purge: boolean },
): Promise<UninstallResult> {
  // The table prefix comes from the catalog, which forgets the app once the
  // manager removes it, so it is read first.
  const tablePrefix = options.purge
    ? await resolveTablePrefixForPurge({ appId, catalog: deps.catalog })
    : null;
  const result = await deps.manager.uninstall(appId, { purge: options.purge });
  if (options.purge && !result.alreadyAbsent) {
    await purgeAppUserData({ appId, tablePrefix, db: deps.db, appsRoot: deps.appsRoot });
  }
  return result;
}
