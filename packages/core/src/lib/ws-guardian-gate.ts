import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { isLoopbackHostname } from "@rome-os/libs/net";
import type { DrizzleDb } from "../db/index.js";
import { createLogger } from "../logger.js";
import { COOKIE_NAME, VISITOR_COOKIE_NAME, verifyVisitorSession } from "./auth.js";
import type { DashboardAccessState } from "./dashboard-access-state.js";
import { resolveGuardianSessionFromMaterial } from "./guardian-session.js";
import { isSameOriginMutationRequest } from "./mutation-origin.js";
import { readCookie, rejectUpgrade, toOriginRequest } from "./ws-upgrade.js";

const log = createLogger("ws-guardian-gate");

/** Who an accepted upgrade belongs to. */
export type UpgradeCaller = { kind: "guardian" } | { kind: "dashboard-visitor"; email: string };

function hasLoopbackHostname(origin: string): boolean {
  try {
    return isLoopbackHostname(new URL(origin).hostname);
  } catch {
    return false;
  }
}

/**
 * Accepts the guardian: a guardian cookie from the dashboard's own origin, or a
 * direct loopback caller that is not a browser page on a non-loopback host. A
 * browser on another origin is refused whatever credential it carries. Writes
 * the 401, 403 or 500 itself and resolves false.
 */
export async function gateGuardianUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  db: DrizzleDb,
): Promise<boolean> {
  return (await gateUpgrade(req, socket, db)) !== null;
}

/**
 * `gateGuardianUpgrade`, and with `dashboardAccess` also a visitor the
 * dashboard allow-list names, from the dashboard's own origin. Resolves the
 * caller, or null once it has written the rejection.
 */
export async function gateUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  db: DrizzleDb,
  dashboardAccess?: Pick<DashboardAccessState, "isCloudEmailAllowed">,
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
      return { kind: "guardian" };
    }
    const visitorToken = dashboardAccess
      ? readCookie(req.headers.cookie, VISITOR_COOKIE_NAME)
      : null;
    const visitor = visitorToken ? verifyVisitorSession(visitorToken) : null;
    if (visitor && dashboardAccess?.isCloudEmailAllowed(visitor.email)) {
      if (!sameOrigin()) {
        rejectUpgrade(socket, 403, "Forbidden");
        return null;
      }
      return { kind: "dashboard-visitor", email: visitor.email };
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
