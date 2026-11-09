import { getCookie } from "hono/cookie";
import type { Context } from "hono";
import { VISITOR_COOKIE_NAME, verifyVisitorSession, type VisitorSession } from "./auth.js";

export type RomeAppViewer = Pick<
  VisitorSession,
  "accountId" | "email" | "favorViewerToken" | "avatarUrl"
>;

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
