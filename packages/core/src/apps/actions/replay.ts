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
  /** The journal sequence of the `pending_approval` entry the resolved card
   *  this replay runs under owns; only that entry may execute. Every other
   *  pending entry stays unauthorized. Undefined on a plain run and on a
   *  replay whose resolved entry could not be named — which binds nothing. */
  approvedSequence?: number;
  /** Set on a root that main runs in-process as a coordination action. Such a
   * root may not call other actions, since a nested call would run app code
   * in main; the engine refuses the call instead. */
  coordinationRoot?: boolean;
}

export const replayContext = new AsyncLocalStorage<ReplayStore>();

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

/** The journal sequence an action-execution approval's card owns. Newer
 *  payloads record `journalSequence`; a payload written before that field
 *  existed derives it from its snapshot, where its own pending entry is the
 *  only `pending_approval` row for its call. Two or more such rows cannot be
 *  told apart from the card alone, so an ambiguous payload binds nothing. */
export function approvedEntrySequence(payload: {
  journalSequence?: unknown;
  actionName?: unknown;
  args?: unknown;
  replayJournal?: unknown;
}): number | undefined {
  if (typeof payload.journalSequence === "number") return payload.journalSequence;
  if (
    typeof payload.actionName !== "string" ||
    !Array.isArray(payload.replayJournal) ||
    payload.args === null ||
    typeof payload.args !== "object" ||
    Array.isArray(payload.args)
  )
    return undefined;
  const argsHash = hashArgs(payload.args as Record<string, unknown>);
  const journal = payload.replayJournal as JournalEntry[];
  const matches = journal.filter(
    (entry) =>
      entry.status === "pending_approval" &&
      entry.actionName === payload.actionName &&
      entry.argsHash === argsHash,
  );
  return matches.length === 1 ? matches[0].sequence : undefined;
}
