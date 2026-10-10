import type { AgentRunnerInterface, AppLogger, RomeAppContext } from "@rome-os/app-runtime";
import { importModuleWithCacheBuster, resolveModuleEntryPath } from "../actions/module-loader.js";
import type { AppCatalog } from "../apps/catalog.js";
import { type ArtifactRef, isResolvedApp } from "../apps/state.js";
import { createAppLogger } from "../logger.js";
import { createRomeAppContext, type RomeAppRuntimeServices } from "../apps/context.js";

/**
 * Deps handed to every app hook's `createHook(deps)` factory. The lifecycle
 * hooks and turn-middleware declare structurally identical
 * dep shapes (`AgentLifecycleHookDeps` / `TurnMiddlewareHookDeps`), so the
 * import + dep-assembly is shared here and the caller asserts the returned
 * hook's own shape (`onAgentTurnStarted` / `handle` / …).
 */
export interface BaseHookDeps {
  appId: string;
  logger: AppLogger;
  appContext?: RomeAppContext;
  agentRunner?: AgentRunnerInterface;
}

/**
 * Import an app hook artifact and run its `createHook(deps)` factory. Returns
 * the constructed hook as `unknown` — each hook kind asserts the concrete
 * contract it needs. Throws if the module does not export `createHook`.
 */
export async function loadAppHook(
  artifact: ArtifactRef,
  catalog: AppCatalog,
  appRuntimeServices: RomeAppRuntimeServices | undefined,
): Promise<unknown> {
  const entryPath = await resolveModuleEntryPath(artifact.absolutePath);
  const module = await importModuleWithCacheBuster(entryPath);
  if (typeof module.createHook !== "function") {
    throw new Error(
      `Hook "${artifact.publicName}" must export createHook(deps) from ${artifact.absolutePath}`,
    );
  }
  const deps: BaseHookDeps = {
    appId: artifact.ownerId,
    logger: createAppLogger(`app:${artifact.ownerId}:${artifact.publicName}`, artifact.ownerId),
  };
  if (appRuntimeServices?.agentRunner) {
    deps.agentRunner = appRuntimeServices.agentRunner;
  }
  const app = appRuntimeServices ? catalog.get(artifact.ownerId) : null;
  if (appRuntimeServices && isResolvedApp(app)) {
    deps.appContext = createRomeAppContext(app, appRuntimeServices);
  }
  return module.createHook(deps);
}
