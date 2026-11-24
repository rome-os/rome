import type { AppLifecycle, AppLifecycleCreateParams } from "@rome-os/app-runtime";
import type { DrizzleDb } from "../db/index.js";
import type { AppCatalog } from "./catalog.js";
import type { AppManager } from "./manager.js";
import { SpecSourceSchema } from "./lockfile.js";
import { scaffoldDevApp } from "./scaffold.js";
import { uninstallApp } from "./uninstall.js";
import { createBundleFetcher } from "./bundle-fetcher.js";
import { remixApp } from "./remix.js";
import type { BundleFetcher } from "./store-bundle.js";

export interface AppLifecycleServiceOptions {
  bundleFetcher?: BundleFetcher;
  installedRoot?: string;
  authoringRoot?: string;
}

/**
 * App-facing coordinator for the app lifecycle. `AppManager` is the sole writer
 * for install/uninstall/setEnabled, but the full operations span more than it:
 * `create` scaffolds a dev tree, and `uninstall --purge` resolves the table
 * prefix from the catalog and drops app-owned tables via the shared db handle.
 * This service composes those collaborators so an action sees one surface — the
 * real service in the main process, an {@link AppLifecycle} proxy (RPC) in a
 * worker, which is mandatory there since the worker holds no writer.
 */
export class AppLifecycleService implements AppLifecycle {
  constructor(
    private readonly manager: AppManager,
    private readonly catalog: AppCatalog,
    private readonly db: DrizzleDb,
    private readonly options: AppLifecycleServiceOptions = {},
  ) {}

  async create(params: AppLifecycleCreateParams) {
    if (params.from) {
      return await remixApp(params, {
        appManager: this.manager,
        appCatalog: this.catalog,
        bundleFetcher: this.options.bundleFetcher ?? createBundleFetcher(),
        installedRoot: this.options.installedRoot,
        authoringRoot: this.options.authoringRoot,
      });
    }
    return await scaffoldDevApp(params.appId, params.rootPath, { template: params.template });
  }

  async install(params: { source: unknown; enabled?: boolean }) {
    const source = SpecSourceSchema.parse(params.source);
    return await this.manager.install({
      source,
      enabled: params.enabled,
    });
  }

  async uninstall(params: { appId: string; purge?: boolean }) {
    return await uninstallApp(
      { manager: this.manager, catalog: this.catalog, db: this.db },
      params.appId,
      { purge: params.purge === true },
    );
  }

  async setEnabled(params: { appId: string; enabled: boolean }) {
    await this.manager.setEnabled(params.appId, params.enabled);
    return { appId: params.appId, enabled: params.enabled };
  }
}
