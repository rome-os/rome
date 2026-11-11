// How an action's work reaches an agent session: the approval handler runs
// the rest of an approved action's turn in the session it came from. Apps says
// what it needs; the app host's backend turn runner supplies it.

import type { BackendTurnParams } from "@rome-os/app-runtime";
import type { SessionActor } from "../../access/session-actor.js";
import type { NotifyLevel } from "../../lib/notify-client.js";
import type { AgentEvent } from "../../types.js";

export interface BackendTurnOptions {
  /** Checked immediately before the turn runs. False drops a stale wake-up. */
  shouldRun?: () => boolean;
  /** The turn is housekeeping for the agent: a chat that draws a typing
   *  indicator for a running turn holds it back until the agent speaks. */
  quiet?: boolean;
  /** Keeps the turn's input in its saved trace under this label. */
  inputLabel?: string;
  /** Pushes the messages the agent says in the turn at this level
   *  (RunParams.pushLevel). Absent, the turn pushes nothing. */
  pushLevel?: NotifyLevel;
  /** Who the turn acts for: the person whose routine or action woke it. Absent, no one. */
  actor?: SessionActor;
}

/** How a backend turn ended: `stopped` when a Stop request cut it short,
 *  `interrupted` when something else did, such as a newer input, and
 *  `failed` when it errored or never ran. */
export type BackendTurnOutcome = "completed" | "stopped" | "interrupted" | "failed";

export interface BackendEmitOptions {
  /** The task already saved this event's trace and delivers its turn's reply
   * itself, so the session stream only shows the event live and mounts its
   * cards. */
  recorded?: boolean;
}

/** A backend session task: code that runs inside a session's stream context and
 * may emit agent messages (rendered as live trace + captured for delivery).
 * `emit` settles once the cards the event carries are written, so a task that
 * awaits it can deliver its reply after them. */
export type BackendSessionTask = (helpers: {
  emit: (msg: AgentEvent & { agent?: string }, options?: BackendEmitOptions) => Promise<void>;
  /** Whether a Stop request reached this task's turn. */
  stopRequested?: () => boolean;
}) => Promise<void>;

/** What the approval handler asks of the session an approved action came from. */
export interface ApprovalSessionRunner {
  /** Run `task` in the session for (channel, threadId). */
  runBackendSessionTask(
    channel: string,
    threadId: string,
    task: BackendSessionTask,
    options?: BackendTurnOptions,
  ): Promise<void>;
  /** Says a messaging channel's reply through the session's speaker, which
   *  sends it and records it in the chat. */
  deliverMessagingReply(
    params: Pick<BackendTurnParams, "agentName" | "channel" | "threadId">,
    reply: string,
    turnId?: string,
  ): Promise<void>;
}
