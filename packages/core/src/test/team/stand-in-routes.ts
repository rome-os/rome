// Routes the stand-in products add to the product in the tree. The
// "guardian-only-route" stand-in mounts routes only the guardian may call,
// each with its own guard, so the stand-in keeps refusing a teammate whatever
// the product does with its guardian-only guards. The "open-socket" stand-in
// attaches a WebSocket path that admits everyone, as `/ws/events` would if it
// lost its gate.

import { createHash } from "node:crypto";
import { Hono } from "hono";
import type { Feature } from "../../api/deps.js";
import { currentSessionActor } from "../../access/session-actor.js";
import type { ExtraUpgrade } from "./instance.js";

export const STAND_IN_GUARDIAN_ONLY_ROUTE = "GET /api/team-verifier/guardian-only";
/** Validates its body before the guard. `bodies.ts` gives it a valid body. */
export const STAND_IN_GUARDIAN_ONLY_WRITE = "POST /api/team-verifier/guardian-only-write";
/** Validates its body before the guard, and has no valid body in `bodies.ts`,
 *  so both callers get the same 400. */
export const STAND_IN_VALIDATES_FIRST = "POST /api/team-verifier/validates-first";

const pathOf = (route: string) => route.slice(route.indexOf(" /api") + " /api".length);

export function guardianOnlyFeature(): Feature {
  const routes = new Hono();
  const isGuardian = async () => (await currentSessionActor())?.kind === "guardian";
  routes.get(pathOf(STAND_IN_GUARDIAN_ONLY_ROUTE), async (c) => {
    if (!(await isGuardian())) return c.json({ error: "guardian only" }, 403);
    return c.json({ ok: true });
  });
  for (const route of [STAND_IN_GUARDIAN_ONLY_WRITE, STAND_IN_VALIDATES_FIRST]) {
    routes.post(pathOf(route), async (c) => {
      const body = (await c.req.json().catch(() => null)) as { confirm?: unknown } | null;
      if (body?.confirm !== true) return c.json({ error: "confirm must be true" }, 400);
      if (!(await isGuardian())) return c.json({ error: "guardian only" }, 403);
      return c.json({ ok: true });
    });
  }
  return { routes, actions: [] };
}

export const STAND_IN_OPEN_SOCKET_PATH = "/ws/team-verifier-open";

/** Completes every handshake on its path, whoever asks. */
export function openSocket(): ExtraUpgrade {
  return {
    path: STAND_IN_OPEN_SOCKET_PATH,
    handle(req, socket) {
      const key = String(req.headers["sec-websocket-key"] ?? "");
      const accept = createHash("sha1")
        .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
        .digest("base64");
      socket.end(
        "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
          `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
      );
    },
  };
}
