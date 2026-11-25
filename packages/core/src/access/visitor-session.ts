import { getCookie } from "hono/cookie";
import type { Context } from "hono";
import { VISITOR_COOKIE_NAME, verifyVisitorSession, type VisitorSession } from "./auth.js";
import type { SessionActor } from "./session-actor.js";

export type RomeAppViewer = Pick<
  VisitorSession,
  "accountId" | "email" | "favorViewerToken" | "avatarUrl"
>;

/** The session actor a visitor's session proves, anonymous without one. */
export function visitorActor(
  viewer: Pick<RomeAppViewer, "accountId" | "email"> | null,
): SessionActor {
  return viewer
    ? { kind: "visitor", accountId: viewer.accountId, email: viewer.email }
    : { kind: "anonymous" };
}

export function resolveVisitorSession(c: Context): RomeAppViewer | null {
  const token = getCookie(c, VISITOR_COOKIE_NAME);
  if (!token) return null;
  const session = verifyVisitorSession(token);
  if (!session) return null;
  return {
    accountId: session.accountId,
    email: session.email,
    favorViewerToken: session.favorViewerToken,
    avatarUrl: session.avatarUrl,
  };
}
