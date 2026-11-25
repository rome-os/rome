// The team: the people who use this Rome as the guardian does. Contract:
// docs/concepts/people.md#team.

import type { DashboardAccessState } from "./dashboard-access-state.js";
import type { SessionActor } from "./session-actor.js";

/** A session actor on the team: the guardian, or a dashboard admin. */
export type TeamActor = Extract<SessionActor, { kind: "guardian" | "visitor" }>;

/** The dashboard allow-list, as it stands when asked. */
export type DashboardAllowList = Pick<DashboardAccessState, "isCloudEmailAllowed">;

/**
 * Whether `actor` is on the team: the guardian, or a visitor whose email is on
 * `allowList` at the moment of the call. A visitor dropped from the list is
 * off the team on the next call.
 */
export function isOnTeam(
  actor: SessionActor | undefined,
  allowList: DashboardAllowList,
): actor is TeamActor {
  if (actor?.kind === "guardian") return true;
  return actor?.kind === "visitor" && allowList.isCloudEmailAllowed(actor.email);
}

/**
 * Whether the person's own signed-in session made the request: a dashboard
 * admin always, the guardian unless a loopback caller, such as an agent's
 * shell, acts as their seat.
 */
export function bySignedInSession(actor: TeamActor): boolean {
  return actor.kind === "visitor" || actor.via === "cookie";
}
