// The lifecycle hooks installed apps offer: `agent-turn-started` and
// `agent-turn-finished` (docs/concepts/apps.md). The composition root reloads
// them on every app catalog event.

import type {
  AgentTurnFinishedEvent,
  AgentTurnFinishedHook,
  AgentTurnStartedEvent,
  AgentTurnStartedHook,
} from "@rome-os/app-runtime";
import type { AppCatalog } from "./catalog.js";
import type { RomeAppRuntimeServices } from "./context.js";
import type { ArtifactRef } from "./state.js";
import { loadAppHook } from "./hook-loader.js";
import {
  createHookDispatchResult,
  evaluateHookInvocation,
  getCurrentOrCreateHookInvocationContext,
  hookTelemetryAttrs,
  recordHookSkip,
  runWithHookInvocationContext,
  type HookDispatchResult,
  type HookIdentity,
  type HookInvocationContext,
} from "../core/hook-recursion.js";
import { createLogger, type Logger } from "../logger.js";
import { wrapHookSpan } from "../telemetry.js";
import type { TurnLifecycle, TurnLifecycleListener } from "../agent/index.js";

const log = createLogger("agent-lifecycle");

export type TurnLifecycleHookName = "agent-turn-started" | "agent-turn-finished";

export interface TurnLifecycleHookLoadFailure {
  appId: string;
  hookName: TurnLifecycleHookName;
  path: string;
  error: string;
}

export interface LoadedLifecycleHook {
  appId: string;
  hookName: TurnLifecycleHookName;
  artifactPath: string;
  hook:
    | AgentTurnStartedHook
    | AgentTurnFinishedHook
    | (AgentTurnStartedHook & AgentTurnFinishedHook);
}

/**
 * Calls every app's hook for a turn that started or ended, best-effort and
 * without waiting, under the hook recursion guard. Each returns how many hooks
 * it invoked and skipped.
 */
export class AppTurnHooks implements TurnLifecycleListener {
  private startedHooks: LoadedLifecycleHook[] = [];
  private finishedHooks: LoadedLifecycleHook[] = [];

  private readonly appRuntimeServices?: RomeAppRuntimeServices;

  constructor(options: { appRuntimeServices?: RomeAppRuntimeServices } = {}) {
    this.appRuntimeServices = options.appRuntimeServices;
  }

  async loadFromCatalog(catalog: AppCatalog): Promise<TurnLifecycleHookLoadFailure[]> {
    const { hooks, failures } = await this.read(catalog, catalog.listArtifacts("hook"));
    this.startedHooks = hooks.filter((hook) => hook.hookName === "agent-turn-started");
    this.finishedHooks = hooks.filter((hook) => hook.hookName === "agent-turn-finished");
    return failures;
  }

  /** Loads one app's lifecycle hooks without adding them. */
  loadApp(
    catalog: AppCatalog,
    appId: string,
  ): Promise<{ hooks: LoadedLifecycleHook[]; failures: TurnLifecycleHookLoadFailure[] }> {
    return this.read(
      catalog,
      catalog.listArtifacts("hook").filter((artifact) => artifact.ownerId === appId),
    );
  }

  /** Adds one loaded hook and returns its undo, which removes that hook only. */
  add(hook: LoadedLifecycleHook): () => void {
    if (hook.hookName === "agent-turn-started") {
      this.startedHooks = [...this.startedHooks, hook];
      return () => {
        this.startedHooks = this.startedHooks.filter((entry) => entry !== hook);
      };
    }
    this.finishedHooks = [...this.finishedHooks, hook];
    return () => {
      this.finishedHooks = this.finishedHooks.filter((entry) => entry !== hook);
    };
  }

  private async read(
    catalog: AppCatalog,
    artifacts: readonly ArtifactRef[],
  ): Promise<{ hooks: LoadedLifecycleHook[]; failures: TurnLifecycleHookLoadFailure[] }> {
    const failures: TurnLifecycleHookLoadFailure[] = [];
    const hooks: LoadedLifecycleHook[] = [];

    for (const artifact of artifacts) {
      if (!isLifecycleHookName(artifact.publicName)) continue;
      try {
        const loaded = await loadLifecycleHook(artifact, catalog, this.appRuntimeServices);
        if (artifact.publicName === "agent-turn-started") {
          assertStartedHook(loaded.hook, artifact);
        } else {
          assertFinishedHook(loaded.hook, artifact);
        }
        hooks.push(loaded);
      } catch (err) {
        failures.push({
          appId: artifact.ownerId,
          hookName: artifact.publicName,
          path: artifact.absolutePath,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return { hooks, failures };
  }

  started(event: AgentTurnStartedEvent): HookDispatchResult {
    return dispatchToAppHooks(this.startedHooks, event, getCurrentOrCreateHookInvocationContext());
  }

  ended(event: AgentTurnFinishedEvent): HookDispatchResult {
    return dispatchToAppHooks(this.finishedHooks, event, getCurrentOrCreateHookInvocationContext());
  }
}

function isLifecycleHookName(value: string): value is TurnLifecycleHookName {
  return value === "agent-turn-started" || value === "agent-turn-finished";
}

async function loadLifecycleHook(
  artifact: ArtifactRef,
  catalog: AppCatalog,
  appRuntimeServices: RomeAppRuntimeServices | undefined,
): Promise<LoadedLifecycleHook> {
  const hook = await loadAppHook(artifact, catalog, appRuntimeServices);
  return {
    appId: artifact.ownerId,
    hookName: artifact.publicName as TurnLifecycleHookName,
    artifactPath: artifact.absolutePath,
    hook: hook as LoadedLifecycleHook["hook"],
  };
}

function assertStartedHook(hook: LoadedLifecycleHook["hook"], artifact: ArtifactRef): void {
  if (typeof (hook as AgentTurnStartedHook).onAgentTurnStarted === "function") return;
  throw new Error(
    `Hook "${artifact.publicName}" from ${artifact.absolutePath} must implement onAgentTurnStarted(event)`,
  );
}

function assertFinishedHook(hook: LoadedLifecycleHook["hook"], artifact: ArtifactRef): void {
  if (typeof (hook as AgentTurnFinishedHook).onAgentTurnFinished === "function") return;
  throw new Error(
    `Hook "${artifact.publicName}" from ${artifact.absolutePath} must implement onAgentTurnFinished(event)`,
  );
}
function dispatchToAppHooks(
  hooks: LoadedLifecycleHook[],
  event: AgentTurnStartedEvent | AgentTurnFinishedEvent,
  parentContext: HookInvocationContext,
): HookDispatchResult {
  const result = createHookDispatchResult();
  for (const loaded of hooks) {
    const identity: HookIdentity = {
      hookType: "lifecycle",
      appId: loaded.appId,
      hookName: loaded.hookName,
    };
    const decision = evaluateHookInvocation(parentContext, identity);
    if (!decision.allowed) {
      result.skipped += 1;
      result.skips.push(decision);
      recordHookSkip(log, decision);
      continue;
    }

    result.invoked += 1;
    void Promise.resolve()
      .then(async () => {
        await runWithHookInvocationContext(decision.nextContext, async () =>
          wrapHookSpan(loaded.hookName, hookTelemetryAttrs(decision), async () => {
            const hookEvent = structuredClone(event) as
              | AgentTurnStartedEvent
              | AgentTurnFinishedEvent;
            if (hookEvent.type === "agent-turn-started") {
              await (loaded.hook as AgentTurnStartedHook).onAgentTurnStarted(hookEvent);
            } else {
              await (loaded.hook as AgentTurnFinishedHook).onAgentTurnFinished(hookEvent);
            }
          }),
        );
      })
      .catch((err) => {
        logHookFailure(log, loaded, event, err);
      });
  }
  return result;
}

function logHookFailure(
  logger: Logger,
  loaded: LoadedLifecycleHook,
  event: AgentTurnStartedEvent | AgentTurnFinishedEvent,
  err: unknown,
): void {
  logger.warn("agent lifecycle hook failed", {
    appId: loaded.appId,
    hookName: loaded.hookName,
    eventType: event.type,
    sessionId: event.turn.sessionId,
    turnId: event.turn.turnId,
    error: err instanceof Error ? err.message : String(err),
  });
}

/**
 * Runs each started and ended turn's calls under one hook invocation context,
 * so work Rome's own listeners start and the app hooks share one hook chain.
 */
export function inOneHookChain(lifecycle: TurnLifecycle): TurnLifecycle {
  return {
    started: (event) =>
      runWithHookInvocationContext(getCurrentOrCreateHookInvocationContext(), () =>
        lifecycle.started(event),
      ),
    ended: (event) =>
      runWithHookInvocationContext(getCurrentOrCreateHookInvocationContext(), () =>
        lifecycle.ended(event),
      ),
    couldNotStart: (event) => lifecycle.couldNotStart(event),
  };
}
