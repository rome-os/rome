// Entry: the one check every way in from outside asks before anything runs.
// Contract: docs/architecture/access-control.md#entry.

import { createLogger } from "../logger.js";
import type { SessionActor } from "./session-actor.js";
import { type DashboardAllowList, isOnTeam, type TeamActor } from "./team.js";

const log = createLogger("entry");

/**
 * How often an open connection asks again whether its person may still enter.
 * Someone no longer a member loses the connection at the latest then.
 */
export const ENTRY_RECHECK_MS = 25_000;

/**
 * The person a session names, if they may enter: the guardian or a member at
 * the moment of the call. Null for anyone else. An absent actor is a person Rome
 * cannot tell, and never enters.
 */
export async function mayEnter(
  actor: SessionActor | undefined,
  allowList: DashboardAllowList,
): Promise<TeamActor | null> {
  return isOnTeam(actor, allowList) ? actor : null;
}

/** A connection's entry while it is open. */
export interface HeldEntry {
  /**
   * Asks again, and runs `take` if the person may still enter. Every input
   * goes through here, and inputs run in the order they came. Once the answer
   * is no it stays no, so someone made a member again opens a new one.
   */
  admit(take: () => void): void;
  /** Asks again, and answers whether the person may still enter. */
  holds(): Promise<boolean>;
  /** Ends the entry. Call when the connection closes. */
  release(): void;
}

/**
 * Holds an entry `mayStillEnter` granted. `onLost` runs once, when an input or
 * the check every {@link ENTRY_RECHECK_MS} first finds it gone, and never after
 * `release()`. A check that fails finds it gone.
 */
export function holdEntry(mayStillEnter: () => Promise<boolean>, onLost: () => void): HeldEntry {
  let held = true;
  const release = () => {
    held = false;
    clearInterval(recheck);
  };
  const check = async () => {
    if (!held) return false;
    const may = await mayStillEnter().catch((err: unknown) => {
      log.warn("entry check failed", { error: err instanceof Error ? err.message : String(err) });
      return false;
    });
    // Another check may have ended the entry meanwhile.
    if (held && !may) {
      release();
      onLost();
    }
    return held;
  };
  const recheck = setInterval(() => void check(), ENTRY_RECHECK_MS);
  let inputs = Promise.resolve();
  return {
    admit(take) {
      inputs = inputs
        .then(async () => {
          if (await check()) take();
        })
        .catch((err: unknown) => {
          log.error("taking an input failed", {
            error: err instanceof Error ? err.message : String(err),
          });
        });
    },
    holds: check,
    release,
  };
}
