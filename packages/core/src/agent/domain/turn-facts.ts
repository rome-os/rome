// What the Rome tools of a session know of the turn that calls them: who runs
// it and where. Agent model: docs/domains/agents.md#rome-tools.

import type { ThreadContext } from "@rome-os/app-runtime";
import type { WidgetDrawing } from "./widget-drawing.js";

/** The level at which a turn pushes the messages it says to the person the chat serves. */
export type PushLevel = "active" | "passive";

/**
 * Who a turn acts for: the person whose message started it, as the request
 * that admitted the message proved. The agent context reads only who it is,
 * to tell two people apart, and hands it to every action the turn calls.
 */
export interface TurnActor {
  readonly kind: string;
  /** The person's Rome Cloud account, when they have one. */
  readonly accountId?: string;
  /** The guardian's seat. */
  readonly userId?: string;
}

/** Whether two inputs speak for the same person, or both for no one. */
export function sameActor(a: TurnActor | undefined, b: TurnActor | undefined): boolean {
  if (!a || !b) return a === b;
  return a.kind === b.kind && a.accountId === b.accountId && a.userId === b.userId;
}

/**
 * Value. The facts about a turn that the ports behind the Rome tools need. A
 * session's own turns share one; a fork's turns have their own. The thread and
 * shared contexts pass through unread.
 */
export interface TurnFacts {
  /** Canonical agent id, e.g. `core:main`. */
  agentName: string;
  continuityKey: string;
  /** The session the turn runs in, or the fork. */
  sessionId: string;
  isSubagent: boolean;
  /** The actions the agent's definition lets it call. */
  actions: readonly string[];
  /** How the session's cards draw. */
  widgets: WidgetDrawing;
  /** The running turn's id, or undefined between turns. */
  turnId(): string | undefined;
  /** Where the running turn stands, else where the session does. */
  threadContext(): ThreadContext | undefined;
  sharedContext(): Record<string, unknown> | undefined;
  /** The level the running turn pushes its messages at, or undefined when it pushes none. */
  pushLevel(): PushLevel | undefined;
  /** Who the running turn acts for, or undefined for a turn no person started. */
  actor(): TurnActor | undefined;
  /** A message of the chat the running turn answers though no message there
   *  started it, as a task's report answers the message that started the
   *  task, or undefined when the turn names none. */
  threadAnchor(): string | undefined;
  /** Runs `fn` in the turn's trace context, so the work it starts nests under the turn. */
  inTurn<T>(fn: () => T): T;
}
