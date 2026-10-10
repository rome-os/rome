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
