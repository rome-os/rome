/**
 * Public API of the imperative apps domain.
 *
 * Three classes — `AppManager` (sole lockfile writer), `AppCatalog`
 * (in-memory read view + subscribers), `AppInstaller` (bundle materialization
 * + manifest resolve). Callers construct the triad with `createAppDomain` or
 * wire them by hand for tests via `createTestApps` in `test-helpers.ts`.
 */
import { AppCatalog } from "./catalog.js";
import { AppInstaller, type BundleFetcher } from "./installer.js";
import { AppManager } from "./manager.js";
import { createBundleFetcher } from "./bundle-fetcher.js";
import type { RomeCloudListingClient } from "./rome-cloud-listing-client.js";

export { AppCatalog } from "./catalog.js";
export { AppInstaller, type BundleFetcher } from "./installer.js";
export { APPSTORE_BUNDLE_MAX_BYTES, fetchVerifiedStoreBundle } from "./store-bundle.js";
export { createBundleFetcher, type CreateBundleFetcherOptions } from "./bundle-fetcher.js";
export {
  createAppStoreService,
  type AppStoreReader,
  type AppStoreListingsBody,
  type AppStoreListingDetailBody,
  type AppStoreListing,
  type AppStoreVersion,
} from "./store-service.js";
export {
  AppManager,
  AppManagerError,
  SYSTEM_APP_ID,
  type AppManagerErrorCode,
  type InstallOpts,
  type InstallResult,
  type UninstallOpts,
  type UninstallResult,
  type BootResult,
} from "./manager.js";

export {
  type AppId,
  type AppView,
  type AppViewState,
  type ArtifactKind,
  type ArtifactRef,
  type CatalogChange,
  type CatalogEvent,
  type InFlightOp,
  type ResolvedApp,
  type ResolvedArtifacts,
  type SubscriberHandler,
  type Unsubscribe,
} from "./state.js";

export {
  APPS_LOCKFILE_SCHEMA_VERSION,
  type AppEntry,
  type AppError,
  type AppLockfile,
  AppLockfileSchema,
  type AppstoreSource,
  type BundleSource,
  type SourceDirSource,
  type SpecSource,
  SpecSourceSchema,
  LockfileTopLevelError,
} from "./lockfile.js";

export { hashWorkspace } from "./packaging/index.js";
export { hydrateCatalogFromLockfile } from "./catalog-hydration.js";
export {
  migrateToLockfile,
  type MigrateOptions,
  type MigrateResult,
} from "./migrate-to-lockfile.js";

export interface AppDomain {
  installer: AppInstaller;
  catalog: AppCatalog;
  manager: AppManager;
}

export interface CreateAppDomainOptions {
  lockfilePath: string;
  installedRoot?: string;
  bundleFetcher?: BundleFetcher;
  /** Used by the installer to resolve omitted `AppstoreSource.contentHash`. */
  romeCloudListings?: RomeCloudListingClient;
}

/**
 * Wire the three apps-domain classes together. The caller registers
 * subscribers via `catalog.subscribe(...)` before invoking
 * `manager.boot()`, so boot-time replay fires through them.
 */
export function createAppDomain(opts: CreateAppDomainOptions): AppDomain {
  const installer = new AppInstaller({
    installedRoot: opts.installedRoot,
    bundleFetcher: opts.bundleFetcher ?? createBundleFetcher(),
    romeCloudListings: opts.romeCloudListings,
  });
  const manager = new AppManager({ lockfilePath: opts.lockfilePath, installer });
  const catalog = new AppCatalog({
    installer,
    readLockfileEntry: (appId) => manager.readLockfileEntry(appId),
    getInFlight: (appId) => manager.getInFlight(appId),
    markBroken: (appId, code, message) => manager.markBroken(appId, code, message),
  });
  manager.attachCatalog(catalog);
  return { installer, catalog, manager };
}
