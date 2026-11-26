// Request bodies the route accepts, for writes whose guard the team change
// moves, so the call gets past body validation to the guard. Every other
// write sends `{}`; a route that answers 400 or 422 to both callers is
// reported as unverified instead of matched.

import { STAND_IN_GUARDIAN_ONLY_WRITE } from "./stand-in-routes.js";

/** Keyed by method and route pattern, as the route table names them. */
const BODIES: Record<string, unknown> = {
  "POST /api/approvals/:id/resolve": { action: "approve" },
  "PUT /api/app-connection-access/:appId/:connectionId/:identity/:operation": {
    approval: "not_required",
  },
  "PUT /api/voice-conversation/settings": { voice: "Iris", speed: 1 },
  [STAND_IN_GUARDIAN_ONLY_WRITE]: { confirm: true },
};

export function bodyFor(method: string, pattern: string): unknown {
  return BODIES[`${method} ${pattern}`] ?? {};
}
