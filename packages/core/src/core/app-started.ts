// Dispatches the `app-started` hook. Contract: docs/concepts/apps.md#hooks.
// Boot ordering: docs/architecture/app-lifecycle.md#app-start.
import type { AppStartedEvent, AppStartedHook } from "@rome-os/app-runtime";
import { Mutex } from "async-mutex";
import type { AppCatalog } from "../apps/catalog.js";
import type { RomeAppRuntimeServices } from "../apps/context.js";
import type { AppId, ArtifactRef, ResolvedApp } from "../apps/state.js";
import { createLogger } from "../logger.js";
import { wrapHookSpan } from "../telemetry.js";
import { loadAppHook } from "./hook-loader.js";
import {
  evaluateHookInvocation,
  getCurrentOrCreateHookInvocationContext,
  hookTelemetryAttrs,
  recordHookSkip,
  resolveHookRecursionConfig,
  runWithHookInvocationContext,
  type HookIdentity,
  type HookRecursionConfig,
} from "./hook-recursion.js";

const log = createLogger("app-started");

export const APP_STARTED_HOOK_NAME = "app-started";

export interface AppStartedHookLoadFailure {
  appId: string;
  path: string;
  error: string;
}

export interface AppStartedDispatcher {
  /**
   * Loads the `app-started` hook for every app start this dispatcher has not
   * seen, and calls it once the dispatcher is open. An app start is one
   * installed bundle of one enabled app, so a re-install of the same bundle
   * does not call the hook again, while an upgrade or a disable followed by an
   * enable does. Returns the load failures of every current app start, not
   * only the ones this call loaded. Never throws for a hook. Overlapping
   * calls run one at a time.
   */
  reconcile(catalog: AppCatalog): Promise<AppStartedHookLoadFailure[]>;
  /**
   * Opens the dispatcher and calls every hook `reconcile` loaded while it was
   * closed. Call once, after boot has made actions, routines, and agents
   * available. Later calls do nothing.
   */
  open(): void;
}

export interface AppStartedDispatcherOptions {
  appRuntimeServices: RomeAppRuntimeServices;
  hookRecursion?: Partial<HookRecursionConfig>;
}

interface LoadedAppStartedHook {
  appId: AppId;
  artifactPath: string;
  hook: AppStartedHook;
  event: AppStartedEvent;
}

export function createAppStartedDispatcher(
  options: AppStartedDispatcherOptions,
): AppStartedDispatcher {
  const hookRecursion = resolveHookRecursionConfig(options.hookRecursion);
  // Each map is keyed by app id. `seen` holds the start key last loaded for
  // the app. `pending` and `failures` hold entries for that same start only,
  // and are cleared with it.
  const seen = new Map<AppId, string>();
  const pending = new Map<AppId, LoadedAppStartedHook[]>();
  const failures = new Map<AppId, AppStartedHookLoadFailure[]>();
  // Loading awaits module imports. Unserialized, a second call could forget
  // an app start the first is still loading, and the first would then
  // dispatch a hook for a bundle that is no longer active.
  const reconcileMutex = new Mutex();
  let opened = false;

  const forget = (appId: AppId): void => {
    seen.delete(appId);
    pending.delete(appId);
    failures.delete(appId);
  };

  return {
    reconcile(catalog) {
      return reconcileMutex.runExclusive(() => reconcileStarts(catalog));
    },

    open() {
      if (opened) return;
      opened = true;
      const queued = [...pending.values()].flat();
      pending.clear();
      for (const entry of queued) dispatch(entry, hookRecursion);
    },
  };

  async function reconcileStarts(catalog: AppCatalog): Promise<AppStartedHookLoadFailure[]> {
    const active = activeAppsWithHook(catalog);

    for (const appId of [...seen.keys()]) {
      const app = active.get(appId);
      if (app) {
        if (startKey(app.app) !== seen.get(appId)) forget(appId);
        continue;
      }
      // An install refreshes the catalog with an `installing` overlay before
      // it writes the new bundle, which drops the app from `listResolved()`
      // until the terminal refresh. Keeping the key across that overlay is
      // what stops a re-install of identical content from counting as a new
      // start. Every other exit from the resolved set ends the start.
      if (catalog.get(appId)?.state !== "installing") forget(appId);
    }

    for (const [appId, { app, artifacts }] of active) {
      if (seen.has(appId)) continue;
      seen.set(appId, startKey(app));

      const loaded: LoadedAppStartedHook[] = [];
      const appFailures: AppStartedHookLoadFailure[] = [];
      for (const artifact of artifacts) {
        try {
          const hook = await loadAppHook(artifact, catalog, options.appRuntimeServices);
          assertAppStartedHook(hook, artifact);
          loaded.push({
            appId,
            artifactPath: artifact.absolutePath,
            hook,
            event: {
              type: "app-started",
              version: 1,
              appId,
              appVersion: app.manifest.version,
            },
          });
        } catch (err) {
          appFailures.push({
            appId,
            path: artifact.absolutePath,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      if (appFailures.length > 0) failures.set(appId, appFailures);
      if (opened) {
        for (const entry of loaded) dispatch(entry, hookRecursion);
      } else if (loaded.length > 0) {
        pending.set(appId, loaded);
      }
    }

    return [...failures.values()].flat();
  }
}

function activeAppsWithHook(
  catalog: AppCatalog,
): Map<AppId, { app: ResolvedApp; artifacts: ArtifactRef[] }> {
  const active = new Map<AppId, { app: ResolvedApp; artifacts: ArtifactRef[] }>();
  for (const app of catalog.listResolved()) {
    const artifacts = app.artifacts.hook.filter(
      (artifact) => artifact.publicName === APP_STARTED_HOOK_NAME,
    );
    if (artifacts.length > 0) active.set(app.appId, { app, artifacts });
  }
  return active;
}

// The installed hash names the bundle's content, so it changes on an upgrade
// and holds across a re-install of identical content. The bundle root is
// content-addressed too, and stands in when a lockfile entry has no hash.
function startKey(app: ResolvedApp): string {
  return app.installedHash ?? app.rootPath;
}

function assertAppStartedHook(
  hook: unknown,
  artifact: ArtifactRef,
): asserts hook is AppStartedHook {
  if (typeof (hook as AppStartedHook | null)?.onAppStarted === "function") return;
  throw new Error(
    `Hook "${artifact.publicName}" from ${artifact.absolutePath} must implement onAppStarted(event)`,
  );
}

function dispatch(loaded: LoadedAppStartedHook, hookRecursion: HookRecursionConfig): void {
  const identity: HookIdentity = {
    hookType: "app",
    appId: loaded.appId,
    hookName: APP_STARTED_HOOK_NAME,
  };
  // An install requested from inside a hook chain carries that chain here, so
  // the hook's own work counts against the same budget.
  const decision = evaluateHookInvocation(
    getCurrentOrCreateHookInvocationContext(),
    identity,
    hookRecursion,
  );
  if (!decision.allowed) {
    recordHookSkip(log, decision, hookRecursion);
    return;
  }

  void Promise.resolve()
    .then(() =>
      runWithHookInvocationContext(decision.nextContext, () =>
        wrapHookSpan(
          APP_STARTED_HOOK_NAME,
          hookTelemetryAttrs(decision, hookRecursion),
          async () => {
            await loaded.hook.onAppStarted(structuredClone(loaded.event));
          },
        ),
      ),
    )
    .catch((err: unknown) => {
      log.warn("app-started hook failed", {
        appId: loaded.appId,
        path: loaded.artifactPath,
        error: err instanceof Error ? err.message : String(err),
      });
    });
}
