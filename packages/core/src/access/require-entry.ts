// The entry step: every dashboard request passes it before its route, so no
// route asks again. Contract: docs/architecture/access-control.md#entry.

import type { Context, MiddlewareHandler } from "hono";
import type { DashboardAccessState } from "./dashboard-access-state.js";
import { mayEnter } from "./entry.js";
import { currentSessionActor, type SessionActor } from "./session-actor.js";
import type { TeamActor } from "./team.js";

type AllowList = Pick<DashboardAccessState, "isCloudEmailAllowed" | "hasCloudEmailAccess">;

const ENTERED = "enteredPerson";

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
    const person = await mayEnter(actor, allowList);
    if (!person) {
      const { status, error } = entryRefusal(actor, allowList);
      return c.json({ error }, status);
    }
    c.set(ENTERED, person);
    await next();
  };
}

/** The person {@link requireEntry} let in. Throws on a path that needs no entry. */
export function enteredPerson(c: Context): TeamActor {
  const person = c.get(ENTERED) as TeamActor | undefined;
  if (!person) throw new Error(`${c.req.path} is not behind the entry step`);
  return person;
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
