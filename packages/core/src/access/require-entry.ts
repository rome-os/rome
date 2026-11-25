// The entry step: every dashboard request passes it before its route, so no
// route asks again. Contract: docs/architecture/access-control.md#entry.

import type { Context, MiddlewareHandler } from "hono";
import type { DashboardAccessState } from "./dashboard-access-state.js";
import { mayEnter } from "./entry.js";
import { holdEntry } from "./held-entry.js";
import { currentSessionActor, type SessionActor } from "./session-actor.js";
import type { TeamActor } from "./team.js";

type AllowList = Pick<DashboardAccessState, "isCloudEmailAllowed" | "hasCloudEmailAccess">;

const ENTERED = "enteredPerson";

/**
 * Lets the guardian and members through to the routes after it, answers anyone
 * else {@link entryRefusal}, and ends an event stream a route answers with once
 * its person may no longer enter. A path `needsNoEntry` names passes
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
    const body = c.res.body;
    if (!body || !c.res.headers.get("Content-Type")?.startsWith("text/event-stream")) return;
    c.res = new Response(whileEntryHolds(body, person, allowList), c.res);
  };
}

/** `source`, ended once `person` may no longer enter. */
function whileEntryHolds(
  source: ReadableStream<Uint8Array>,
  person: TeamActor,
  allowList: AllowList,
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  let ended = false;
  let release = () => {};
  return new ReadableStream<Uint8Array>({
    start(controller) {
      release = holdEntry(person, allowList, () => {
        ended = true;
        controller.close();
        void reader.cancel().catch(() => {});
      });
    },
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (ended) return;
        if (!done) return controller.enqueue(value);
        release();
        controller.close();
      } catch (err) {
        if (ended) return;
        release();
        controller.error(err);
      }
    },
    async cancel(reason) {
      release();
      await reader.cancel(reason);
    },
  });
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
