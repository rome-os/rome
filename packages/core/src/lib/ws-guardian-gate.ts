import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { DrizzleDb } from "../db/index.js";
import { createLogger } from "../logger.js";
import { COOKIE_NAME } from "./auth.js";
import { resolveGuardianSessionFromMaterial } from "./guardian-session.js";
import { isSameOriginMutationRequest } from "./mutation-origin.js";
import { readCookie, rejectUpgrade, toOriginRequest } from "./ws-upgrade.js";

const log = createLogger("ws-guardian-gate");

export async function gateGuardianUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  db: DrizzleDb,
): Promise<boolean> {
  try {
    const guardian = await resolveGuardianSessionFromMaterial(
      {
        sessionToken: readCookie(req.headers.cookie, COOKIE_NAME),
        hasForwardedFor: Boolean(req.headers["x-forwarded-for"]),
        peerAddress: req.socket.remoteAddress ?? undefined,
      },
      db,
    );
    if (socket.destroyed) return false;
    if (!guardian) {
      rejectUpgrade(socket, 401, "Unauthorized");
      return false;
    }
    if (guardian.via === "cookie" && !isSameOriginMutationRequest(toOriginRequest(req))) {
      rejectUpgrade(socket, 403, "Forbidden");
      return false;
    }
    return true;
  } catch (err) {
    log.error("guardian upgrade check failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    rejectUpgrade(socket, 500, "Internal Server Error");
    return false;
  }
}
