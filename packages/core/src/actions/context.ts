import { AsyncLocalStorage } from "node:async_hooks";
import {
  setCurrentActionContextResolver,
  setCurrentActionContextRunner,
  type CurrentActionContextPatch,
} from "@rome-os/app-runtime";
import type { ActionEngine } from "./engine.js";
import type { ActionRunObserver } from "./runtime-events.js";
import type { ThreadContext } from "../core/types.js";
import type { SessionActor } from "../lib/session-actor.js";

export interface ActionExecutionStore {
  actionName?: string;
  executionId: string;
  rootExecutionId: string;
  parentExecutionId?: string;
  parentActionName?: string;
  initiator: string;
  /** Authenticated session identity accountable for this chain. Inherited from
   * root to every nested/detached hop, unlike `callerAppId`. */
  actor?: SessionActor;
  /** The app that directly invoked this action via its app-context `runAction`
   * (per-hop, never inherited). Undefined for agent / user / system calls. */
  callerAppId?: string;
  engine?: ActionEngine;
  channelContext?: ThreadContext;
  sharedContext?: Record<string, unknown>;
  sessionId?: string;
  /** Durable Rome session id of the calling agent session. Undefined for
   * routine / hook / app-initiated chains, which have no agent session. */
  romeSessionId?: string;
  turnId?: string;
  agentName?: string;
  channelThreadKey?: string;
  runtimeObserver?: ActionRunObserver;
}

export const actionExecutionContext = new AsyncLocalStorage<ActionExecutionStore>();

setCurrentActionContextResolver(() => {
  const store = actionExecutionContext.getStore();
  if (!store) {
    return undefined;
  }

  return {
    actionName: store.actionName,
    executionId: store.executionId,
    rootExecutionId: store.rootExecutionId,
    parentExecutionId: store.parentExecutionId,
    parentActionName: store.parentActionName,
    callerAppId: store.callerAppId,
    channelContext: store.channelContext,
    sessionId: store.sessionId,
    romeSessionId: store.romeSessionId,
    turnId: store.turnId,
    agentName: store.agentName,
    channelThreadKey: store.channelThreadKey,
    sharedContext: store.sharedContext,
  };
});

function mergeSharedContext(
  store: ActionExecutionStore,
  patch: CurrentActionContextPatch,
): Record<string, unknown> | undefined {
  if (patch.sharedContext === undefined) {
    return store.sharedContext;
  }

  return {
    ...(store.sharedContext ?? {}),
    ...patch.sharedContext,
  };
}

setCurrentActionContextRunner(async <T>(patch: CurrentActionContextPatch, fn: () => Promise<T>) => {
  const store = actionExecutionContext.getStore();
  if (!store) {
    return await fn();
  }

  return await actionExecutionContext.run(
    {
      ...store,
      ...patch,
      sharedContext: mergeSharedContext(store, patch),
    },
    fn,
  );
});
