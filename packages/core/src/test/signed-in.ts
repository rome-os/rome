import type { Hono } from "hono";
import {
  currentSessionActor,
  runWithSessionActor,
  type SessionActor,
} from "../access/session-actor.js";

export const GUARDIAN: SessionActor = { kind: "guardian", userId: "guardian-1", via: "cookie" };

/**
 * `app` with the guardian signed in, as the session middleware leaves it. A
 * request a test sends as someone else stays theirs.
 */
export function asGuardian<T extends Pick<Hono, "fetch">>(app: T): T {
  const fetch = app.fetch;
  app.fetch = async (...args) =>
    (await currentSessionActor())
      ? fetch(...args)
      : runWithSessionActor(GUARDIAN, () => fetch(...args));
  return app;
}
