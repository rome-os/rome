import type { ActionLoader } from "../apps/actions/loader.js";
import type { ActionRegistryImpl } from "../apps/actions/registry.js";
import type { ActionEngine } from "../apps/actions/engine.js";
import type { Action, ActionConfig } from "../apps/actions/types.js";
import type { ChannelMessageHook } from "../apps/hooks/types.js";
import { createLogger, type Logger } from "../logger.js";
import type { DrizzleDb } from "../db/index.js";
import type { RoutinesRepository } from "../db/repositories/routines.js";
import type {
  ActionExecutionContext,
  AppRuntimeRepositories,
  ChannelMessageHookDeps,
} from "@rome-os/app-runtime";
import type { AppCatalog } from "../apps/catalog.js";
import {
  type ArtifactRef,
  type CatalogEvent,
  isResolvedApp,
  type ResolvedApp,
  type SubscriberHandler,
} from "../apps/state.js";
import type { ArtifactMetadata } from "../apps/types.js";
import { createRomeAppContext, type RomeAppContext } from "../apps/context.js";
import {
  importModuleWithCacheBuster,
  instantiateActionFromDirectory,
  resolveModuleEntryPath,
} from "../apps/actions/module-loader.js";
import type { AppFavorRequests } from "../apps/app-favors-port.js";
import type { HostExecutionService } from "../apps/host-execution/service.js";
import type { FeedbackService } from "../instance/feedback-client.js";
import type { CloudProfileService } from "../instance/cloud-profile.js";
import type { AgentNamesService } from "../chats/accounts/agent-names.js";
import { withRemovedMembers } from "../lib/removed-members.js";
import type { AppConnectionsContextFactory } from "../apps/app-connections-port.js";
import { AppActionSchemaCache } from "../apps/actions/app-action-schema-cache.js";
import { deprecatedActionDeps } from "./deprecated-app-ports.js";

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
  favorService?: AppFavorRequests;
  appConnections?: AppConnectionsContextFactory;
  hostExecution?: HostExecutionService;
  /** System-only: reporter provenance must come from system:send_feedback. */
  feedback?: FeedbackService;
  /** System-only: apps read the guardian's Cloud profile only via system:get_guardian_cloud_profile. */
  cloudProfile?: CloudProfileService;
  /** System-only: lists the guardian's agents and linked accounts', so only
   *  system:send_message resolves a name in it. */
  agentNames?: AgentNamesService;
}

interface AppLookup {
  (appId: string): ResolvedApp | null;
}

function makeAppLookup(catalog: AppCatalog): AppLookup {
  return (appId: string) => {
    const view = catalog.get(appId);
    return isResolvedApp(view) ? view : null;
  };
}

/**
 * Deps that @rome-os/app-runtime 0.7 removed, answered with the migration
 * ({@link withRemovedMembers}).
 *
 * TODO(0.8): remove, with REMOVED_HOOK_DEPS.
 */
const REMOVED_ACTION_DEPS: Record<string, string> = {
  talkRouter:
    "deps.talkRouter was removed in @rome-os/app-runtime 0.7: send and read on channels through deps.channelsService",
};
// TODO(0.8): remove, with REMOVED_ACTION_DEPS.
const REMOVED_HOOK_DEPS: Record<string, string> = {
  talkRouter:
    "deps.talkRouter was removed in @rome-os/app-runtime 0.7: a hook hears through deps.channels (channel.inbound.subscribe) and answers through channel.send",
};

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

  return withRemovedMembers(
    {
      ...deprecatedActionDeps(),
      ...deps,
      ...(record.metadata.ownerId === "system" && services.hostExecution
        ? { hostExecution: services.hostExecution }
        : {}),
      ...(record.metadata.ownerId === "system" && services.feedback
        ? { feedback: services.feedback }
        : {}),
      ...(record.metadata.ownerId === "system" && services.cloudProfile
        ? { cloudProfile: services.cloudProfile }
        : {}),
      ...(record.metadata.ownerId === "system" && services.agentNames
        ? { agentNames: services.agentNames }
        : {}),
      appContext: createRomeAppContext(app, {
        catalog,
        db: services.db,
        actionEngine: services.actionEngine,
        routinesRepo: services.routinesRepo,
        repositories: services.repositories,
        favorService: services.favorService,
        appConnections: services.appConnections,
      }),
    } satisfies AppActionRuntimeDeps<Record<string, unknown>>,
    REMOVED_ACTION_DEPS,
  );
}

function createLazyAppAction(
  record: AppActionRecord,
  catalog: AppCatalog,
  deps: Record<string, unknown>,
  services: AppActionServices,
  inputSchema?: Record<string, unknown>,
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
    ...(inputSchema ? { inputSchema } : {}),
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

/**
 * Registers the app actions the loader knows, importing each module so a
 * module that fails to load stays unregistered and is reported in `failed`.
 *
 * With a `schemaCache`, an action whose schema is cached from an earlier import
 * of the same bundle registers without an import. Its module loads on first
 * use, so a load failure surfaces from that call instead of in `failed`.
 */
export async function registerAppActions(
  actionLoader: ActionLoader,
  actionRegistry: ActionRegistryImpl,
  catalog: AppCatalog,
  deps: Record<string, unknown>,
  services: AppActionServices,
  options: { onlyAppId?: string; schemaCache?: AppActionSchemaCache | null } = {},
): Promise<{ loaded: string[]; failed: AppActionLoadFailure[] }> {
  const loaded: string[] = [];
  const failed: AppActionLoadFailure[] = [];
  const schemaCache = options.schemaCache ?? null;

  for (const [name, record] of actionLoader.getAllRecords()) {
    if (record.metadata.ownerType !== "app") {
      continue;
    }
    if (options.onlyAppId !== undefined && record.metadata.ownerId !== options.onlyAppId) {
      continue;
    }

    const cacheKey = schemaCache
      ? AppActionSchemaCache.key(
          record.metadata.ownerId,
          catalog.get(record.metadata.ownerId)?.installedHash ?? null,
          name,
        )
      : null;
    const cached = cacheKey ? schemaCache?.get(cacheKey) : undefined;
    if (cached) {
      actionRegistry.register(
        createLazyAppAction(record, catalog, deps, services, cached.inputSchema ?? undefined),
        record.metadata,
      );
      loaded.push(name);
      continue;
    }

    try {
      const action = await instantiateActionFromDirectory(
        record.config,
        record.directory,
        createAppActionRuntimeDeps(record, catalog, deps, services),
      );
      actionRegistry.register(action, record.metadata);
      if (cacheKey) schemaCache?.set(cacheKey, action.inputSchema);
      loaded.push(name);
    } catch (err) {
      failed.push({
        name,
        ownerId: record.metadata.ownerId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  await schemaCache?.save();
  return { loaded, failed };
}

export function registerLazyAppActions(
  actionLoader: ActionLoader,
  actionRegistry: ActionRegistryImpl,
  catalog: AppCatalog,
  deps: Record<string, unknown>,
  services: AppActionServices,
): { loaded: string[] } {
  const loaded: string[] = [];

  for (const [name, record] of actionLoader.getAllRecords()) {
    if (record.metadata.ownerType !== "app") {
      continue;
    }

    actionRegistry.register(createLazyAppAction(record, catalog, deps, services), record.metadata);
    loaded.push(name);
  }

  return { loaded };
}

const appActionsLog = createLogger("app-actions");

/**
 * Must subscribe after `actionLoaderSubscriber` so the loader's record map is
 * already up-to-date when we instantiate. Warns with the event's app actions
 * that failed to initialize, which stay unregistered.
 */
export function createAppActionsSubscriber(
  actionLoader: ActionLoader,
  actionRegistry: ActionRegistryImpl,
  catalog: AppCatalog,
  deps: Record<string, unknown>,
  services: AppActionServices,
  log: Pick<Logger, "warn"> = appActionsLog,
  schemaCache: AppActionSchemaCache | null = null,
): SubscriberHandler {
  return async function appActionsSubscriber(event: CatalogEvent) {
    actionRegistry.unregisterOwnedBy("app", event.appId);
    if (event.change === "removed") return;
    if (!isResolvedApp(event.current)) return;
    const { failed } = await registerAppActions(
      actionLoader,
      actionRegistry,
      catalog,
      deps,
      services,
      { onlyAppId: event.appId, schemaCache },
    );
    if (failed.length > 0) {
      log.warn("some app actions failed to initialize", { appId: event.appId, failed });
    }
  };
}

const hookLog = createLogger("channel-message-hook-loader");

/** Import one app's `channel-message` hook and create it with `deps`. Throws
 *  when the module exports no `createHook`. */
export async function createChannelMessageHook(
  artifact: Pick<ArtifactRef, "absolutePath" | "ownerId" | "publicName">,
  deps: ChannelMessageHookDeps,
  log: Pick<Logger, "warn"> = hookLog,
): Promise<ChannelMessageHook> {
  const entryPath = await resolveModuleEntryPath(artifact.absolutePath);
  const module = await importModuleWithCacheBuster(entryPath);

  if (typeof module.createHook === "function") {
    const hook = module.createHook(
      withRemovedMembers({ ...deps }, REMOVED_HOOK_DEPS),
    ) as ChannelMessageHook;
    // A hook built against @rome-os/app-runtime 0.6 may subscribe only in the
    // removed registerConnection, which the host no longer calls: it would hear
    // nothing and say nothing. Name the migration instead.
    if (typeof (hook as { registerConnection?: unknown }).registerConnection === "function") {
      log.warn(
        "channel-message hook defines the removed registerConnection; subscribe through deps.channels in register()",
        { owner: artifact.ownerId },
      );
    }
    return hook;
  }

  throw new Error(
    `Hook "${artifact.publicName}" must export createHook(deps) from ${artifact.absolutePath}`,
  );
}
