// The entry step: every dashboard request passes it before its route. Contract: docs/architecture/access-control.md#entry.

import type { MiddlewareHandler } from "hono";
import type { DashboardAccessState } from "./dashboard-access-state.js";
import { mayEnter } from "./entry.js";
import { currentSessionActor, type SessionActor } from "./session-actor.js";

type AllowList = Pick<DashboardAccessState, "isCloudEmailAllowed" | "hasCloudEmailAccess">;

/**
 * Lets the guardian and members through to the routes after it, and answers
 * anyone else {@link entryRefusal}. A path `needsNoEntry` names passes
 * unasked. Mount it after the session actor middleware.
 */
export function requireEntry(
  allowList: AllowList,
  needsNoEntry: (path: string) => boolean,
): MiddlewareHandler {
  return async (c, next) => {
    if (needsNoEntry(c.req.path)) return next();
    const actor = await currentSessionActor();
    if (!(await mayEnter(actor, allowList))) {
      const { status, error } = entryRefusal(actor, allowList);
      return c.json({ error }, status);
    }
    await next();
  };
}

/** What someone who may not enter is answered, at the edge and at the step. */
export function entryRefusal(
  actor: SessionActor | undefined,
  allowList: AllowList,
): { status: 401 | 403; error: string } {
  if (!allowList.hasCloudEmailAccess()) return { status: 401, error: "Unauthorized" };
  return actor?.kind === "visitor"
    ? { status: 403, error: "Forbidden" }
    : { status: 401, error: "Visitor authentication required" };
}
