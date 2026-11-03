// What a panel button did, as far as this tab can tell. A button is a message
// to the Concierge, which does the work and writes the row, so the row stays
// as it was until that write arrives. Until then the row shows the action as
// pending. The state is local to the tab: another device sees the row change
// when the Concierge writes it.

import { useEffect, useSyncExternalStore } from "react";
import type { ConciergeTaskAction } from "@rome/api-types/concierge";

/** How long a button waits for the Concierge before the row says so. */
export const PENDING_TIMEOUT_MS = 60_000;

type PendingPhase =
  /** Sent; the Concierge has not written the row. */
  | "pending"
  /** The turn that took the press in ended and left the row as it was. */
  | "unchanged"
  /** No write after {@link PENDING_TIMEOUT_MS}. */
  | "timeout"
  /** The message was not sent. */
  | "failed";

export interface PendingAction {
  action: ConciergeTaskAction;
  phase: PendingPhase;
  startedAt: number;
  /** The row's `updatedAt` when the button was pressed. A write by the
   *  Concierge is later than this, and both times are the server's. */
  baseUpdatedAt: number;
  /** The id of the message the press sent, which names the turn that takes it in. */
  inputId: string;
}

let pending: ReadonlyMap<string, PendingAction> = new Map();
const listeners = new Set<() => void>();

function commit(next: Map<string, PendingAction>): void {
  pending = next;
  for (const listener of listeners) listener();
}

function update(taskId: string, fn: (entry: PendingAction) => PendingAction | null): void {
  const entry = pending.get(taskId);
  if (!entry) return;
  const changed = fn(entry);
  const next = new Map(pending);
  if (changed) next.set(taskId, changed);
  else next.delete(taskId);
  if (changed !== entry) commit(next);
}

/** A button was pressed on a row. */
export function beginPending(
  taskId: string,
  action: ConciergeTaskAction,
  baseUpdatedAt: number,
  inputId: string,
  now = Date.now(),
): void {
  commit(
    new Map(pending).set(taskId, {
      action,
      phase: "pending",
      startedAt: now,
      baseUpdatedAt,
      inputId,
    }),
  );
}

/** The Concierge wrote a row. A write later than the button settles it. */
export function settlePending(task: { id: string; updatedAt: number }): void {
  update(task.id, (entry) => (task.updatedAt > entry.baseUpdatedAt ? null : entry));
}

/** The turn that took the press in ended without a write to the row. */
export function markUnchanged(taskId: string): void {
  update(taskId, (entry) => (entry.phase === "pending" ? { ...entry, phase: "unchanged" } : entry));
}

/** The presses still waiting, as they are now. */
export function getPending(): ReadonlyMap<string, PendingAction> {
  return pending;
}

/** Moves buttons that waited too long to `timeout`. */
export function expirePending(now = Date.now()): void {
  for (const [taskId, entry] of pending) {
    if (entry.phase === "pending" && now - entry.startedAt >= PENDING_TIMEOUT_MS) {
      update(taskId, (held) => ({ ...held, phase: "timeout" }));
    }
  }
}

export function failPending(taskId: string): void {
  update(taskId, (entry) => ({ ...entry, phase: "failed" }));
}

/** Forgets everything. For tests. */
export function resetPending(): void {
  commit(new Map());
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** The buttons pressed in this tab and not yet settled, by row id. */
export function usePendingActions(): ReadonlyMap<string, PendingAction> {
  const snapshot = useSyncExternalStore(
    subscribe,
    () => pending,
    () => pending,
  );
  const waiting = [...snapshot.values()].some((entry) => entry.phase === "pending");
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => expirePending(), 1_000);
    return () => clearInterval(timer);
  }, [waiting]);
  return snapshot;
}
