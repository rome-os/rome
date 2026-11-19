// A route guard that lets only the guardian in, for routes whose context
// cannot read the session itself. Session actors: ./session-actor.ts.

import type { MiddlewareHandler } from "hono";
import { currentSessionActor } from "./session-actor.js";

/** Answers 403 unless the request's session is the guardian's, and runs the route otherwise. */
export const guardianOnly: MiddlewareHandler = async (c, next) => {
  if ((await currentSessionActor())?.kind !== "guardian")
    return c.json({ error: "Guardian authentication required" }, 403);
  await next();
};
