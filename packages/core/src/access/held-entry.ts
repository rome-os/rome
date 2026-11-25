// Holds a member's entry over a connection that stays open, for the boundary
// that opened it. Contract: docs/architecture/access-control.md#entry.

import { createLogger } from "../logger.js";
import { mayEnter } from "./entry.js";
import type { DashboardAllowList, TeamActor } from "./team.js";

const log = createLogger("entry");

/** How often an open connection's entry is asked again. */
export const ENTRY_RECHECK_MS = 25_000;

/**
 * Asks every {@link ENTRY_RECHECK_MS} whether `actor` may still enter, and runs
 * `onLost` once when they may not or the question fails. Call the answered
 * function when the connection closes: `onLost` never runs after it. The
 * guardian's entry never ends.
 */
export function holdEntry(
  actor: TeamActor,
  allowList: DashboardAllowList,
  onLost: () => void,
): () => void {
  if (actor.kind === "guardian") return () => {};
  let held = true;
  const release = () => {
    held = false;
    clearInterval(recheck);
  };
  const recheck = setInterval(async () => {
    const still = await mayEnter(actor, allowList).catch((err: unknown) => {
      log.warn("entry check failed", { error: err instanceof Error ? err.message : String(err) });
      return null;
    });
    if (still || !held) return;
    release();
    onLost();
  }, ENTRY_RECHECK_MS);
  return release;
}
