// How a Concierge task stands, derived from facts Rome holds: a wait on its
// owner, a running turn, a check scheduled for later, how its chat's last
// turn ended, and whether it was stopped. The Concierge never writes it.
// Server, web and iOS read it through `taskStatus`, as they read a chat's
// activity through `conciergeActivity`. docs/domains/chats.md#task

import type { ConciergeStatusReaction, ConciergeTaskState } from "./concierge.js";

/** The four states a task is in, one at a time. */
export const CONCIERGE_TASK_STATUSES = ["needs_you", "active", "later", "ended"] as const;
export type ConciergeTaskStatus = (typeof CONCIERGE_TASK_STATUSES)[number];

/** Why an ended task ended. */
export const CONCIERGE_TASK_END_REASONS = ["done", "failed", "stopped", "no_response"] as const;
export type ConciergeTaskEndReason = (typeof CONCIERGE_TASK_END_REASONS)[number];

/** How the task chat's latest turn ended, or its start failed. */
export type ConciergeTaskOutcome = "succeeded" | "failed" | "stopped";

/** A task's state and, once it ended, why. */
export interface ConciergeTaskStatusResult {
  status: ConciergeTaskStatus;
  endReason: ConciergeTaskEndReason | null;
}

/** The facts a task's status follows from. Times are epoch milliseconds. */
export interface ConciergeTaskFacts {
  /** When the task was stopped, by the Concierge, its owner, or its chat's archive or delete. */
  stoppedAt: number | null;
  /** When the newest question card or approval in its task chat that is still unanswered began, or null. */
  waitingSince: number | null;
  /** A turn runs or is queued in its task chat. */
  running: boolean;
  /** Its task chat's result waits for the Concierge turn that reports it. */
  reportPending: boolean;
  /** When a check scheduled for the task is due, or null when none is pending. */
  laterAt: number | null;
  lastOutcome: ConciergeTaskOutcome | null;
}

/** How long a wait on the owner keeps a task waiting for them, by default: a day. */
export const CONCIERGE_TASK_WAIT_EXPIRY_MS = 24 * 60 * 60 * 1000;

/**
 * A task's status, checked in this order: stopped is always ended·stopped;
 * then a wait on its owner younger than `waitExpiryMs` (needs you); then a
 * running or queued turn, or a result waiting to be reported (active); then a
 * pending check (later); else ended, with its reason. A wait older than
 * `waitExpiryMs` with nothing running ends the task for no response.
 */
export function taskStatus(
  facts: ConciergeTaskFacts,
  now: number,
  waitExpiryMs: number = CONCIERGE_TASK_WAIT_EXPIRY_MS,
): ConciergeTaskStatusResult {
  if (facts.stoppedAt !== null) return { status: "ended", endReason: "stopped" };
  const waiting = facts.waitingSince !== null;
  if (waiting && now - (facts.waitingSince as number) < waitExpiryMs) {
    return { status: "needs_you", endReason: null };
  }
  if (facts.running || facts.reportPending) return { status: "active", endReason: null };
  if (facts.laterAt !== null) return { status: "later", endReason: null };
  if (waiting) return { status: "ended", endReason: "no_response" };
  if (facts.lastOutcome === "failed") return { status: "ended", endReason: "failed" };
  if (facts.lastOutcome === "stopped") return { status: "ended", endReason: "stopped" };
  return { status: "ended", endReason: "done" };
}

/**
 * The state an app from before derived status reads, mapped from the status
 * so it keeps showing the task right: a task that ended other than done reads
 * as dropped.
 */
export function legacyTaskState({
  status,
  endReason,
}: ConciergeTaskStatusResult): ConciergeTaskState {
  switch (status) {
    case "needs_you":
      return "needs_user";
    case "active":
      return "doing";
    case "later":
      return "watching";
    default:
      return endReason === "done" ? "done" : "dropped";
  }
}

const STATUSES = new Set<string>(CONCIERGE_TASK_STATUSES);
const END_REASONS = new Set<string>(CONCIERGE_TASK_END_REASONS);

/**
 * Reads a status off the wire. A status this client does not know reads as
 * active, and an end reason it does not know as done, so a newer server
 * never breaks it. Never throws.
 */
export function parseTaskStatus(status: unknown, endReason: unknown): ConciergeTaskStatusResult {
  if (typeof status !== "string" || !STATUSES.has(status)) {
    return { status: "active", endReason: null };
  }
  if (status !== "ended") return { status: status as ConciergeTaskStatus, endReason: null };
  return {
    status: "ended",
    endReason:
      typeof endReason === "string" && END_REASONS.has(endReason)
        ? (endReason as ConciergeTaskEndReason)
        : "done",
  };
}

/**
 * A task row's status as a client reads it: the status Rome sent, read with
 * {@link parseTaskStatus}, or, from a server before it, mapped from the state.
 */
export function taskStatusOfDto(task: {
  state: ConciergeTaskState;
  status?: unknown;
  endReason?: unknown;
}): ConciergeTaskStatusResult {
  if (task.status !== undefined) return parseTaskStatus(task.status, task.endReason);
  switch (task.state) {
    case "needs_user":
      return { status: "needs_you", endReason: null };
    case "doing":
      return { status: "active", endReason: null };
    case "next":
    case "watching":
      return { status: "later", endReason: null };
    case "dropped":
      return { status: "ended", endReason: "stopped" };
    default:
      return { status: "ended", endReason: "done" };
  }
}

/** What a guardian message's status reaction follows from. */
export interface MessageMarkFacts {
  /** Whether the turn that took the message answered it; null when no turn took it. */
  answered: boolean | null;
  /** Whether that turn failed, by an error or a crash, before it answered. A stop or a newer input is no failure. */
  turnFailed?: boolean;
  /**
   * The status of each task made for the message, and whether Rome gave up
   * telling the Concierge its result, so its owner was never told.
   */
  tasks: readonly (ConciergeTaskStatusResult & { reportLost?: boolean })[];
}

/**
 * A guardian message's status reaction (docs/domains/chats.md#status-reaction):
 * working while its turn has not answered it, or a task made for it waits
 * for its owner, is active or is checked later; failed when its turn failed,
 * a task made for it ended failed, or Rome gave up telling a task's result;
 * else none. A task that ended for no response shows none.
 */
export function messageStatusReaction(facts: MessageMarkFacts): ConciergeStatusReaction | null {
  const open = (task: ConciergeTaskStatusResult) => task.status !== "ended";
  if (facts.answered === false || facts.tasks.some(open)) return "working";
  const failed =
    facts.turnFailed === true ||
    facts.tasks.some((task) => task.endReason === "failed" || task.reportLost === true);
  return failed ? "failed" : null;
}
