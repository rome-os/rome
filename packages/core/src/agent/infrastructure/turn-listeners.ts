// Delivers what the agent context tells Rome about each turn to everyone who
// listens: Rome's own listeners, such as the Concierge and the skill review,
// then the apps' lifecycle hooks.

import type { AgentTurnFinishedEvent, AgentTurnStartedEvent } from "@rome-os/app-runtime";
import {
  getCurrentOrCreateHookInvocationContext,
  runWithHookInvocationContext,
} from "../../core/hook-recursion.js";
import { createLogger } from "../../logger.js";
import type {
  AgentTurnFailedBeforeStart,
  TurnLifecycle,
  TurnLifecycleListener,
} from "../domain/turn-lifecycle.js";
import type { AppTurnHooks } from "./app-turn-hooks.js";

const log = createLogger("agent-lifecycle");

/**
 * Rome's own listeners hear each call in the order they listened, and a
 * listener that throws is logged and skipped. A started or ended turn then
 * reaches the app hooks, all under one hook invocation context, so work a
 * listener starts and the hooks share one hook chain.
 */
export class TurnListeners implements TurnLifecycle {
  private readonly listeners = new Set<TurnLifecycleListener>();

  constructor(private readonly appHooks: Pick<AppTurnHooks, "started" | "ended">) {}

  /** Returns the call that stops listening. */
  listen(listener: TurnLifecycleListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  started(event: AgentTurnStartedEvent): void {
    const context = getCurrentOrCreateHookInvocationContext();
    runWithHookInvocationContext(context, () => {
      for (const listener of this.listeners) {
        if (!listener.started) continue;
        try {
          listener.started(event);
        } catch (err) {
          log.warn("agent lifecycle started listener threw", {
            error: err instanceof Error ? err.message : String(err),
            sessionId: event.turn.sessionId,
            turnId: event.turn.turnId,
          });
        }
      }
      this.appHooks.started(event);
    });
  }

  ended(event: AgentTurnFinishedEvent): void {
    const context = getCurrentOrCreateHookInvocationContext();
    runWithHookInvocationContext(context, () => {
      for (const listener of this.listeners) {
        if (!listener.ended) continue;
        try {
          listener.ended(event);
        } catch (err) {
          log.warn("agent lifecycle finished listener threw", {
            error: err instanceof Error ? err.message : String(err),
            sessionId: event.turn.sessionId,
            turnId: event.turn.turnId,
          });
        }
      }
      this.appHooks.ended(event);
    });
  }

  couldNotStart(event: AgentTurnFailedBeforeStart): void {
    for (const listener of this.listeners) {
      if (!listener.couldNotStart) continue;
      try {
        listener.couldNotStart(event);
      } catch (err) {
        log.warn("agent lifecycle failed-before-start listener threw", {
          error: err instanceof Error ? err.message : String(err),
          turnId: event.turn.turnId,
        });
      }
    }
  }
}
