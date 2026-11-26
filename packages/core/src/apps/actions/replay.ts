import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import type { ActionResult, PendingApproval } from "./types.js";

export interface JournalEntry {
  sequence: number;
  actionName: string;
  argsHash: string;
  args: Record<string, unknown>;
  result: ActionResult | null;
  status: "completed" | "pending_approval" | "diverged";
  expectedActionName?: string;
  expectedArgsHash?: string;
  actualActionName?: string;
  actualArgsHash?: string;
}

export interface ReplayStore {
  rootExecutionId: string;
  rootActionName: string;
  rootArgs: Record<string, unknown>;
  journal: JournalEntry[];
  nextSequence: number;
  replayIndex: number;
  mode: "record" | "replay";
  /**
   * Set when a nested call requests approval during this run. The root call
   * surfaces this as its own `pending_approval` result so callers of the root
   * see the same signal regardless of where the approval originated.
   */
  pendingApproval?: PendingApproval;
  /** On an approval replay, the sequence of the pending entry the approved
   *  card owns. Only that entry executes; other pending entries stay parked. */
  approvedSequence?: number;
  /** Entries loaded before this run. Replay never matches past them, so rows
   *  appended during this run are never mistaken for history. */
  preloadedEntryCount?: number;
  /** Set on a root that main runs in-process as a coordination action. Such a
   * root may not call other actions, since a nested call would run app code
   * in main; the engine refuses the call instead. */
  coordinationRoot?: boolean;
}

export const replayContext = new AsyncLocalStorage<ReplayStore>();

/** Set while a call executes for real during a replay. Its own nested calls
 *  were never journaled, so they record instead of matching replay rows. */
export const freshCallContext = new AsyncLocalStorage<true>();

/** Deterministic JSON serialization with sorted keys for stable hashing. */
function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return JSON.stringify(value);
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return "[" + value.map(stableStringify).join(",") + "]";
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return (
    "{" +
    keys
      .map((k) => JSON.stringify(k) + ":" + stableStringify((value as Record<string, unknown>)[k]))
      .join(",") +
    "}"
  );
}

/** Compute a stable hash for action args to detect replay divergence. */
export function hashArgs(args: Record<string, unknown>): string {
  return createHash("sha256").update(stableStringify(args)).digest("base64url");
}

/** The journal sequence an action-execution card owns. A payload written
 *  before `journalSequence` existed falls back to its snapshot's only pending
 *  row for the call; two identical rows are ambiguous, so it binds nothing. */
export function approvedEntrySequence(payload: {
  journalSequence?: unknown;
  actionName?: unknown;
  args?: unknown;
  replayJournal?: unknown;
}): number | undefined {
  if (typeof payload.journalSequence === "number") return payload.journalSequence;
  if (typeof payload.actionName !== "string" || !Array.isArray(payload.replayJournal)) {
    return undefined;
  }
  const argsHash = hashArgs((payload.args ?? {}) as Record<string, unknown>);
  const matches = (payload.replayJournal as JournalEntry[]).filter(
    (entry) =>
      entry.status === "pending_approval" &&
      entry.actionName === payload.actionName &&
      entry.argsHash === argsHash,
  );
  return matches.length === 1 ? matches[0].sequence : undefined;
}
