// A route guard that lets only the team in, for routes whose context cannot
// read the session itself. The team: ./team.ts.

import type { MiddlewareHandler } from "hono";
import { currentSessionActor } from "./session-actor.js";
import { type DashboardAllowList, isOnTeam } from "./team.js";

/** Answers 403 unless the request's session is on the team, and runs the route otherwise. */
export function teamOnly(allowList: DashboardAllowList): MiddlewareHandler {
  return async (c, next) => {
    if (!isOnTeam(await currentSessionActor(), allowList))
      return c.json({ error: "Guardian authentication required" }, 403);
    await next();
  };
}
