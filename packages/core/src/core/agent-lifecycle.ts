import { randomUUID } from "node:crypto";
import type {
  AgentStop,
  AgentTurnFinishedEvent,
  AgentTurnFinishedHook,
  AgentTurnRef,
  AgentTurnStartedEvent,
  AgentTurnStartedHook,
  AgentTurnStatus,
  AgentTurnTiming,
  LifecycleThreadContext,
} from "@rome-os/app-runtime";
import type { AppCatalog } from "../apps/catalog.js";
import type { ArtifactRef } from "../apps/state.js";
import type { ThreadContext } from "./types.js";
import { createLogger, type Logger } from "../logger.js";
import type { RomeAppRuntimeServices } from "../apps/context.js";
import { wrapHookSpan } from "../telemetry.js";
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
} from "./hook-recursion.js";

const log = createLogger("agent-lifecycle");

export type AgentLifecycleEventName = "agent-turn-started" | "agent-turn-finished";

export interface AgentLifecycleHookLoadFailure {
  appId: string;
  hookName: AgentLifecycleEventName;
  path: string;
  error: string;
}

export interface AgentTurnParentRef {
  sessionId: string;
  turnId: string;
  agentName: string;
}

interface LoadedLifecycleHook {
  appId: string;
  hookName: AgentLifecycleEventName;
  artifactPath: string;
  hook:
    | AgentTurnStartedHook
    | AgentTurnFinishedHook
    | (AgentTurnStartedHook & AgentTurnFinishedHook);
}

export interface AgentLifecycleDispatcher {
  loadFromCatalog(catalog: AppCatalog): Promise<AgentLifecycleHookLoadFailure[]>;
  dispatchStarted(event: AgentTurnStartedEvent): HookDispatchResult;
  dispatchFinished(event: AgentTurnFinishedEvent): HookDispatchResult;
  onFinished(listener: (event: AgentTurnFinishedEvent) => void): () => void;
}

export interface AgentLifecycleDispatcherOptions {
  appRuntimeServices?: RomeAppRuntimeServices;
}

export function toLifecycleThreadContext(
  context: ThreadContext | undefined,
): LifecycleThreadContext | undefined {
  if (!context) return undefined;
  return {
    channel: context.channel,
    threadId: context.threadId,
    threadPath: context.threadPath,
    channelUserId: context.channelUserId,
    threadName: context.threadName,
    threadType: context.threadType,
    projectName: context.projectName,
    projectPath: context.projectPath,
  };
}

export function createAgentTurnRef(params: {
  sessionId: string;
  turnId: string;
  agentName: string;
  channelThreadKey?: string;
  threadContext?: ThreadContext;
  parent?: AgentTurnParentRef;
}): AgentTurnRef {
  return {
    sessionId: params.sessionId,
    turnId: params.turnId,
    agentName: params.agentName,
    channelThreadKey: params.channelThreadKey,
    threadContext: toLifecycleThreadContext(params.threadContext),
    parent: params.parent,
  };
}

export function classifyAgentTurnStatus(params: {
  terminalKind?: "result" | "error";
  stop?: AgentStop;
  interrupted: boolean;
}): AgentTurnStatus {
  if (params.interrupted || params.stop?.reason === "interrupted") {
    return "interrupted";
  }
  if (params.terminalKind === "error") {
    return "error";
  }
  if (params.terminalKind === "result") {
    return "completed";
  }
  return "stopped";
}

export function createAgentLifecycleDispatcher(
  options: AgentLifecycleDispatcherOptions = {},
): AgentLifecycleDispatcher {
  let startedHooks: LoadedLifecycleHook[] = [];
  let finishedHooks: LoadedLifecycleHook[] = [];
  const finishedListeners = new Map<string, (event: AgentTurnFinishedEvent) => void>();

  return {
    async loadFromCatalog(catalog) {
      const failures: AgentLifecycleHookLoadFailure[] = [];
      const nextStarted: LoadedLifecycleHook[] = [];
      const nextFinished: LoadedLifecycleHook[] = [];

      for (const artifact of catalog.listArtifacts("hook")) {
        if (!isLifecycleHookName(artifact.publicName)) continue;
        try {
          const loaded = await loadLifecycleHook(artifact, catalog, options.appRuntimeServices);
          if (artifact.publicName === "agent-turn-started") {
            assertStartedHook(loaded.hook, artifact);
            nextStarted.push(loaded);
          } else {
            assertFinishedHook(loaded.hook, artifact);
            nextFinished.push(loaded);
          }
        } catch (err) {
          failures.push({
            appId: artifact.ownerId,
            hookName: artifact.publicName,
            path: artifact.absolutePath,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      startedHooks = nextStarted;
      finishedHooks = nextFinished;
      return failures;
    },

    dispatchStarted(event) {
      const parentContext = getCurrentOrCreateHookInvocationContext();
      return dispatchToAppHooks(startedHooks, event, parentContext);
    },

    dispatchFinished(event) {
      const parentContext = getCurrentOrCreateHookInvocationContext();
      for (const listener of finishedListeners.values()) {
        try {
          runWithHookInvocationContext(parentContext, () => {
            listener(event);
          });
        } catch (err) {
          log.warn("agent lifecycle finished listener threw", {
            error: err instanceof Error ? err.message : String(err),
            sessionId: event.turn.sessionId,
            turnId: event.turn.turnId,
          });
        }
      }
      return dispatchToAppHooks(finishedHooks, event, parentContext);
    },

    onFinished(listener) {
      const id = randomUUID();
      finishedListeners.set(id, listener);
      return () => {
        finishedListeners.delete(id);
      };
    },
  };
}

function isLifecycleHookName(value: string): value is AgentLifecycleEventName {
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
    hookName: artifact.publicName as AgentLifecycleEventName,
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

export function buildRequiredTiming(params: {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
}): Required<AgentTurnTiming> {
  return {
    startedAt: params.startedAt,
    finishedAt: params.finishedAt,
    durationMs: params.durationMs,
  };
}
