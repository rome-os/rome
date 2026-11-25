import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { isLoopbackHostname } from "@rome-os/libs/net";
import type { DrizzleDb } from "../db/index.js";
import { createLogger } from "../logger.js";
import { mayEnter } from "./entry.js";
import { holdEntry } from "./held-entry.js";
import { resolveSessionActorFromMaterial, upgradeActorMaterial } from "./session-actor.js";
import type { DashboardAllowList, TeamActor } from "./team.js";
import { isSameOriginMutationRequest } from "../lib/mutation-origin.js";
import { rejectUpgrade, toOriginRequest } from "../lib/ws-upgrade.js";

const log = createLogger("ws-guardian-gate");

function hasLoopbackHostname(origin: string): boolean {
  try {
    return isLoopbackHostname(new URL(origin).hostname);
  } catch {
    return false;
  }
}

function fromAllowedOrigin(req: IncomingMessage, actor: TeamActor): boolean {
  const sameOrigin = () => isSameOriginMutationRequest(toOriginRequest(req));
  if (actor.kind === "visitor" || actor.via === "cookie") return sameOrigin();
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
 * not a browser page on a non-loopback host, and a member, from the dashboard's
 * own origin. A browser on another origin is refused whatever credential it
 * carries. Resolves the person, or null once it has written the 401, 403 or
 * 500. Once the person may no longer enter it destroys the socket, so the
 * caller only cleans up when its socket closes.
 */
export async function gateUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  db: DrizzleDb,
  dashboardAccess: DashboardAllowList,
): Promise<TeamActor | null> {
  try {
    const actor = await mayEnter(
      await resolveSessionActorFromMaterial(upgradeActorMaterial(req), db),
      dashboardAccess,
    );
    if (socket.destroyed) return null;
    if (!actor) {
      rejectUpgrade(socket, 401, "Unauthorized");
      return null;
    }
    if (!fromAllowedOrigin(req, actor)) {
      rejectUpgrade(socket, 403, "Forbidden");
      return null;
    }
    socket.once(
      "close",
      holdEntry(actor, dashboardAccess, () => socket.destroy()),
    );
    return actor;
  } catch (err) {
    log.error("guardian upgrade check failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    rejectUpgrade(socket, 500, "Internal Server Error");
    return null;
  }
}
