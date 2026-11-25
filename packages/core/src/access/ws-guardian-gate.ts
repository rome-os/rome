import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { isLoopbackHostname } from "@rome-os/libs/net";
import type { DrizzleDb } from "../db/index.js";
import { createLogger } from "../logger.js";
import { COOKIE_NAME, VISITOR_COOKIE_NAME, verifyVisitorSession } from "./auth.js";
import { mayEnter } from "./entry.js";
import { type GuardianSession, resolveGuardianSessionFromMaterial } from "./guardian-session.js";
import type { DashboardAllowList, TeamActor } from "./team.js";
import { isSameOriginMutationRequest } from "../lib/mutation-origin.js";
import { readCookie, rejectUpgrade, toOriginRequest } from "../lib/ws-upgrade.js";

const log = createLogger("ws-guardian-gate");

/** Whose session an upgrade carries, and who an accepted one belongs to. */
export type UpgradeCaller =
  | { kind: "guardian"; userId: string; via: GuardianSession["via"] }
  | { kind: "dashboard-admin"; accountId: string; email: string };

/** The session actor an accepted upgrade proved. */
export function actorOfUpgrade(caller: UpgradeCaller): TeamActor {
  return caller.kind === "guardian"
    ? { kind: "guardian", userId: caller.userId, via: caller.via }
    : { kind: "visitor", accountId: caller.accountId, email: caller.email };
}

function hasLoopbackHostname(origin: string): boolean {
  try {
    return isLoopbackHostname(new URL(origin).hostname);
  } catch {
    return false;
  }
}

/** Whoever the request's session names, whether or not they may enter. */
async function callerOf(req: IncomingMessage, db: DrizzleDb): Promise<UpgradeCaller | null> {
  const guardian = await resolveGuardianSessionFromMaterial(
    {
      sessionToken: readCookie(req.headers.cookie, COOKIE_NAME),
      hasForwardedFor: Boolean(req.headers["x-forwarded-for"]),
      peerAddress: req.socket.remoteAddress ?? undefined,
    },
    db,
  );
  if (guardian) return { kind: "guardian", userId: guardian.userId, via: guardian.via };
  const visitorToken = readCookie(req.headers.cookie, VISITOR_COOKIE_NAME);
  const visitor = visitorToken ? verifyVisitorSession(visitorToken) : null;
  return visitor
    ? { kind: "dashboard-admin", accountId: visitor.accountId, email: visitor.email }
    : null;
}

function fromAllowedOrigin(req: IncomingMessage, caller: UpgradeCaller): boolean {
  const sameOrigin = () => isSameOriginMutationRequest(toOriginRequest(req));
  if (caller.kind === "dashboard-admin" || caller.via === "cookie") return sameOrigin();
  // Browsers send Origin on every WebSocket handshake and CORS does not
  // apply, so a page on any site can open one to loopback. The in-container
  // browser visits arbitrary sites, so a loopback caller with an Origin
  // must still be the dashboard. Host does not prove that: a DNS-rebound
  // name sends a matching Origin and Host, so the name must be loopback too.
  const origin = req.headers.origin;
  return origin === undefined || (hasLoopbackHostname(origin) && sameOrigin());
}

/**
 * Accepts whoever may enter ({@link mayEnter}): the guardian, by a guardian
 * cookie from the dashboard's own origin or as a direct loopback caller that is
 * not a browser page on a non-loopback host, and a dashboard admin, from the
 * dashboard's own origin. A browser on another origin is refused whatever
 * credential it carries. Resolves the caller, or null once it has written the
 * 401, 403 or 500.
 */
export async function gateUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  db: DrizzleDb,
  dashboardAccess: DashboardAllowList,
): Promise<UpgradeCaller | null> {
  try {
    const caller = await callerOf(req, db);
    if (socket.destroyed) return null;
    if (!caller || !(await mayEnter(actorOfUpgrade(caller), dashboardAccess))) {
      rejectUpgrade(socket, 401, "Unauthorized");
      return null;
    }
    if (!fromAllowedOrigin(req, caller)) {
      rejectUpgrade(socket, 403, "Forbidden");
      return null;
    }
    return caller;
  } catch (err) {
    log.error("guardian upgrade check failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    rejectUpgrade(socket, 500, "Internal Server Error");
    return null;
  }
}
