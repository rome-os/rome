// Entry: the one check every way in from outside asks before anything runs.
// Contract: docs/architecture/access-control.md#entry.

import type { SessionActor } from "./session-actor.js";
import { type DashboardAllowList, isOnTeam, type TeamActor } from "./team.js";

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
