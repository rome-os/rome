import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { isLoopbackHostname } from "@rome-os/libs/net";
import type { DrizzleDb } from "../db/index.js";
import { createLogger } from "../logger.js";
import { COOKIE_NAME, VISITOR_COOKIE_NAME, verifyVisitorSession } from "./auth.js";
import { type GuardianSession, resolveGuardianSessionFromMaterial } from "./guardian-session.js";
import type { SessionActor } from "./session-actor.js";
import { type DashboardAllowList, isOnTeam, type TeamActor } from "./team.js";
import { isSameOriginMutationRequest } from "../lib/mutation-origin.js";
import { readCookie, rejectUpgrade, toOriginRequest } from "../lib/ws-upgrade.js";

const log = createLogger("ws-guardian-gate");

/** Who an accepted upgrade belongs to. */
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

/**
 * Accepts the guardian: a guardian cookie from the dashboard's own origin, or a
 * direct loopback caller that is not a browser page on a non-loopback host.
 * With `dashboardAccess` it also accepts a visitor the dashboard allow-list
 * names, from the dashboard's own origin. A browser on another origin is
 * refused whatever credential it carries. Resolves the caller, or null once it
 * has written the 401, 403 or 500.
 */
export async function gateUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  db: DrizzleDb,
  dashboardAccess?: DashboardAllowList,
): Promise<UpgradeCaller | null> {
  try {
    const guardian = await resolveGuardianSessionFromMaterial(
      {
        sessionToken: readCookie(req.headers.cookie, COOKIE_NAME),
        hasForwardedFor: Boolean(req.headers["x-forwarded-for"]),
        peerAddress: req.socket.remoteAddress ?? undefined,
      },
      db,
    );
    if (socket.destroyed) return null;
    const sameOrigin = () => isSameOriginMutationRequest(toOriginRequest(req));
    if (guardian) {
      // Browsers send Origin on every WebSocket handshake and CORS does not
      // apply, so a page on any site can open one to loopback. The in-container
      // browser visits arbitrary sites, so a loopback caller with an Origin
      // must still be the dashboard. Host does not prove that: a DNS-rebound
      // name sends a matching Origin and Host, so the name must be loopback too.
      const origin = req.headers.origin;
      const refused =
        guardian.via === "cookie"
          ? !sameOrigin()
          : origin !== undefined && (!hasLoopbackHostname(origin) || !sameOrigin());
      if (refused) {
        rejectUpgrade(socket, 403, "Forbidden");
        return null;
      }
      return { kind: "guardian", userId: guardian.userId, via: guardian.via };
    }
    const visitorToken = dashboardAccess
      ? readCookie(req.headers.cookie, VISITOR_COOKIE_NAME)
      : null;
    const session = visitorToken ? verifyVisitorSession(visitorToken) : null;
    const visitor: Extract<SessionActor, { kind: "visitor" }> | undefined = session
      ? { kind: "visitor", accountId: session.accountId, email: session.email }
      : undefined;
    if (visitor && dashboardAccess && isOnTeam(visitor, dashboardAccess)) {
      if (!sameOrigin()) {
        rejectUpgrade(socket, 403, "Forbidden");
        return null;
      }
      return { kind: "dashboard-admin", accountId: visitor.accountId, email: visitor.email };
    }
    rejectUpgrade(socket, 401, "Unauthorized");
    return null;
  } catch (err) {
    log.error("guardian upgrade check failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    rejectUpgrade(socket, 500, "Internal Server Error");
    return null;
  }
}
