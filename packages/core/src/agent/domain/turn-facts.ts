// What the Rome tools of a session know of the turn that calls them: who runs
// it and where. Agent model: docs/domains/agents.md#rome-tools.

import type { ThreadContext } from "@rome-os/app-runtime";
import type { WidgetDrawing } from "./widget-drawing.js";

/** The level at which a turn pushes the first message it says to the guardian. */
export type PushLevel = "active" | "passive";

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
  /** The level the running turn pushes its first message at, or undefined when it pushes none. */
  pushLevel(): PushLevel | undefined;
  /** A message of the chat the running turn answers though no message there
   *  started it, as a task's report answers the message that started the
   *  task, or undefined when the turn names none. */
  threadAnchor(): string | undefined;
  /** Runs `fn` in the turn's trace context, so the work it starts nests under the turn. */
  inTurn<T>(fn: () => T): T;
}
