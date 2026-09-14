import type { ActionLoader } from "./loader.js";
import type { ActionRegistryImpl } from "./registry.js";
import type { ActionEngine } from "./engine.js";
import type { Action, ActionConfig } from "./types.js";
import type { ChannelMessageHook } from "../hooks/types.js";
import type { DrizzleDb } from "../db/index.js";
import type { RoutinesRepository } from "../db/repositories/routines.js";
import type { ActionExecutionContext, AppRuntimeRepositories } from "@rome-os/app-runtime";
import type { AppCatalog } from "../apps/catalog.js";
import type { CatalogEvent, ResolvedApp, SubscriberHandler } from "../apps/state.js";
import type { ArtifactMetadata } from "../apps/types.js";
import { createRomeAppContext, type RomeAppContext } from "../apps/context.js";
import {
  importModuleWithCacheBuster,
  instantiateActionFromDirectory,
  resolveModuleEntryPath,
} from "./module-loader.js";
import type { FavorService } from "../favors/types.js";
import type { HostExecutionService } from "../host-execution/service.js";

export interface AppActionLoadFailure {
  name: string;
  ownerId: string;
  error: string;
}

export function formatAppActionLoadFailures(failures: AppActionLoadFailure[]): string {
  return failures
    .map((failure) => `${failure.name} (${failure.ownerId}): ${failure.error}`)
    .join("; ");
}

export function assertNoAppActionLoadFailures(
  failures: AppActionLoadFailure[],
  processName: "main" | "worker",
): void {
  if (failures.length === 0) {
    return;
  }

  throw new Error(
    `Failed to load app actions in ${processName}: ${formatAppActionLoadFailures(failures)}`,
  );
}

export function assertRequiredActionRegistered(
  registry: { has(name: string): boolean },
  actionName: string,
): void {
  if (registry.has(actionName)) {
    return;
  }

  throw new Error(`Required action "${actionName}" is not registered`);
}

export function assertRequiredHookPresent<T>(hook: T | null, hookName: string): T {
  if (hook) {
    return hook;
  }

  throw new Error(`Required hook "${hookName}" is not registered`);
}

export function createNoopChannelMessageHook(): ChannelMessageHook {
  return {
    async register() {},
    registerConnection() {},
    unregister() {},
  };
}

export type AppActionRuntimeDeps<TShared = Record<string, unknown>> = TShared & {
  appContext: RomeAppContext;
};

type AppActionRecord = {
  config: ActionConfig;
  metadata: ArtifactMetadata;
  directory: string;
};

interface AppActionServices {
  db: DrizzleDb;
  actionEngine: ActionEngine;
  routinesRepo?: RoutinesRepository;
  repositories: AppRuntimeRepositories;
  favorService?: FavorService;
  hostExecution?: HostExecutionService;
}

interface AppLookup {
  (appId: string): ResolvedApp | null;
}

function makeAppLookup(catalog: AppCatalog): AppLookup {
  return (appId: string) => {
    const view = catalog.get(appId);
    if (!view) return null;
    if ((view as ResolvedApp).manifest === undefined) return null;
    return view as ResolvedApp;
  };
}

function createAppActionRuntimeDeps(
  record: AppActionRecord,
  catalog: AppCatalog,
  deps: Record<string, unknown>,
  services: AppActionServices,
): AppActionRuntimeDeps<Record<string, unknown>> {
  const app = makeAppLookup(catalog)(record.metadata.ownerId);
  if (!app) {
    throw new Error(`App "${record.metadata.ownerId}" is not resolved in the catalog`);
  }

  return {
    ...deps,
    ...(record.metadata.ownerId === "system" && services.hostExecution
      ? { hostExecution: services.hostExecution }
      : {}),
    appContext: createRomeAppContext(app, {
      catalog,
      db: services.db,
      actionEngine: services.actionEngine,
      routinesRepo: services.routinesRepo,
      repositories: services.repositories,
      favorService: services.favorService,
    }),
  } satisfies AppActionRuntimeDeps<Record<string, unknown>>;
}

function createLazyAppAction(
  record: AppActionRecord,
  catalog: AppCatalog,
  deps: Record<string, unknown>,
  services: AppActionServices,
): Action {
  let actionPromise: Promise<Action> | null = null;

  const load = async (): Promise<Action> => {
    if (!actionPromise) {
      actionPromise = instantiateActionFromDirectory(
        record.config,
        record.directory,
        createAppActionRuntimeDeps(record, catalog, deps, services),
      ).catch((err) => {
        actionPromise = null;
        throw err;
      });
    }
    return actionPromise;
  };

  return {
    config: record.config,
    async execute(args: Record<string, unknown>, context?: ActionExecutionContext) {
      const action = await load();
      return action.execute(args, context);
    },
    async preview(args: Record<string, unknown>) {
      const action = await load();
      return action.preview?.(args);
    },
  };
}

export async function registerAppActions(
  actionLoader: ActionLoader,
  actionRegistry: ActionRegistryImpl,
  catalog: AppCatalog,
  deps: Record<string, unknown>,
  services: AppActionServices,
  options: { onlyAppId?: string } = {},
): Promise<{ loaded: string[]; failed: AppActionLoadFailure[] }> {
  const loaded: string[] = [];
  const failed: AppActionLoadFailure[] = [];

  for (const [name, record] of actionLoader.getAllRecords()) {
    if (record.metadata.ownerType !== "app") {
      continue;
    }
    if (options.onlyAppId !== undefined && record.metadata.ownerId !== options.onlyAppId) {
      continue;
    }

    try {
      const action = await instantiateActionFromDirectory(record.config, record.directory, {
        ...createAppActionRuntimeDeps(record, catalog, deps, services),
      });
      actionRegistry.register(action, record.metadata);
      loaded.push(name);
    } catch (err) {
      failed.push({
        name,
        ownerId: record.metadata.ownerId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { loaded, failed };
}

export function registerLazyAppActions(
  actionLoader: ActionLoader,
  actionRegistry: ActionRegistryImpl,
  catalog: AppCatalog,
  deps: Record<string, unknown>,
  services: AppActionServices,
  options: { onlyAppId?: string } = {},
): { loaded: string[]; failed: AppActionLoadFailure[] } {
  const loaded: string[] = [];
  const failed: AppActionLoadFailure[] = [];

  for (const [name, record] of actionLoader.getAllRecords()) {
    if (record.metadata.ownerType !== "app") {
      continue;
    }
    if (options.onlyAppId !== undefined && record.metadata.ownerId !== options.onlyAppId) {
      continue;
    }

    actionRegistry.register(createLazyAppAction(record, catalog, deps, services), record.metadata);
    loaded.push(name);
  }

  return { loaded, failed };
}

/**
 * Must subscribe after `actionLoaderSubscriber` so the loader's record map is
 * already up-to-date when we instantiate.
 */
export function createAppActionsSubscriber(
  actionLoader: ActionLoader,
  actionRegistry: ActionRegistryImpl,
  catalog: AppCatalog,
  deps: Record<string, unknown>,
  services: AppActionServices,
): SubscriberHandler {
  return async function appActionsSubscriber(event: CatalogEvent) {
    actionRegistry.unregisterOwnedBy("app", event.appId);
    if (event.change === "removed") return;
    const current = event.current;
    if (current == null) return;
    if ((current as ResolvedApp).manifest === undefined) return;
    await registerAppActions(actionLoader, actionRegistry, catalog, deps, services, {
      onlyAppId: event.appId,
    });
  };
}

export async function createChannelMessageHookFromCatalog(
  catalog: AppCatalog,
  deps: unknown,
): Promise<ChannelMessageHook | null> {
  const hooks = catalog.listArtifacts("hook");
  const hookRef = hooks.find((artifact) => artifact.publicName === "channel-message");
  if (!hookRef) {
    return null;
  }

  const entryPath = await resolveModuleEntryPath(hookRef.absolutePath);
  const module = await importModuleWithCacheBuster(entryPath);

  if (typeof module.createHook === "function") {
    return module.createHook(deps) as ChannelMessageHook;
  }

  throw new Error(
    `Hook "${hookRef.publicName}" must export createHook(deps) from ${hookRef.absolutePath}`,
  );
}

/**
 * Rebuilds the live channel-message hook from the catalog — the app-keys
 * refresh path. The hook is instantiated once at boot and retained by
 * subscription closures, so recreating it is the only way a module-scope env
 * capture in its module graph follows a key change. The swap is
 * double-dispatch-safe: the old instance detaches before the new one
 * registers, and a hook without `unregister()` is left in place (stale but
 * single) rather than doubled. If the fresh instance fails to register, the
 * previous one is re-registered so inbound messages keep flowing; the error
 * propagates for the caller to report.
 */
export function createChannelMessageHookReloader(options: {
  catalog: AppCatalog;
  deps: unknown;
  getCurrent: () => ChannelMessageHook;
  setCurrent: (hook: ChannelMessageHook) => void;
  onSkip?: (reason: string) => void;
}): () => Promise<void> {
  return async () => {
    const previous = options.getCurrent();
    if (typeof previous.unregister !== "function") {
      options.onSkip?.("channel-message hook has no unregister(); keeping the current instance");
      return;
    }
    const reloaded = await createChannelMessageHookFromCatalog(options.catalog, options.deps);
    if (!reloaded) return;
    previous.unregister();
    options.setCurrent(reloaded);
    try {
      await reloaded.register();
    } catch (err) {
      options.setCurrent(previous);
      await previous.register();
      throw err;
    }
  };
}
