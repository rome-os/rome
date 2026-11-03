import type { ApiConnection, GrantState } from "@/lib/connections-api";

/** A fixture connection's state, derived from its grants the way core derives
 *  it: broken while a grant is degraded, working once every grant is
 *  authorized, and null otherwise. */
export function stateOfGrants(grants: Record<string, GrantState>): ApiConnection["state"] {
  const states = Object.values(grants);
  if (states.includes("degraded")) return "broken";
  return states.every((state) => state === "authorized") ? "working" : null;
}
