// The people who call the dashboard, and how a call from each reaches Rome:
// through the `forward_auth` probe first when the edge gates the path, then to
// the route with the headers the probe hands forward, as Caddy does.

import { request as httpRequest } from "node:http";
import { randomBytes } from "node:crypto";
import type { Server } from "node:http";
import type { Duplex } from "node:stream";
import type { Hono } from "hono";
import {
  COOKIE_NAME,
  VISITOR_COOKIE_NAME,
  createSession,
  createVisitorSession,
} from "../../access/auth.js";
import { GUARDIAN, OUTSIDER, TEAMMATE } from "./instance.js";
import { reachOf, type HttpOperation, type UpgradeOperation } from "./surface.js";

export type Role = "guardian" | "teammate" | "outsider" | "anonymous";

export const INSTANCE_HOST = "team.verifier.test";

export function cookieOf(role: Role): string | null {
  switch (role) {
    case "guardian":
      return `${COOKIE_NAME}=${createSession(GUARDIAN.userId)}`;
    case "teammate":
      return `${VISITOR_COOKIE_NAME}=${createVisitorSession(TEAMMATE.accountId, TEAMMATE.email, "favor-teammate")}`;
    case "outsider":
      return `${VISITOR_COOKIE_NAME}=${createVisitorSession(OUTSIDER.accountId, OUTSIDER.email, "favor-outsider")}`;
    case "anonymous":
      return null;
  }
}

/** What one call came to. `refused` is a 401 or 403 from the probe or the route. */
export interface Outcome {
  /** "edge" when the probe refused it, else "route". */
  stage: "edge" | "route";
  /** The HTTP status, 101 for an accepted upgrade, or "timeout". */
  status: number | "timeout";
  refused: boolean;
}

const CALL_TIMEOUT_MS = 5_000;
const PROBE_COPIED_HEADERS = [
  "X-Rome-User-Id",
  "X-Rome-Visitor-Account-Id",
  "X-Rome-Visitor-Email",
];

const isRefusal = (status: number | "timeout") => status === 401 || status === 403;

let requestsSent = 0;

/** Headers every browser request through Caddy carries. The forwarded address
 *  keeps the in-container loopback trust from applying, as it never does to a
 *  request from outside. Each request comes from its own address: the login
 *  rate limit counts per address for the whole process, so one shared address
 *  would answer a later run's login with 429 for what earlier runs sent. */
export function browserHeaders(cookie: string | null): Record<string, string> {
  requestsSent += 1;
  return {
    ...(cookie ? { cookie } : {}),
    "x-forwarded-for": `2001:db8::${requestsSent.toString(16)}`,
    "x-forwarded-proto": "https",
    "sec-fetch-site": "same-origin",
    origin: `https://${INSTANCE_HOST}`,
  };
}

async function withTimeout<T>(promise: Promise<T>): Promise<T | "timeout"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), CALL_TIMEOUT_MS);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Asks the probe about `path` the way Caddy's `forward_auth` does. */
async function probe(app: Browsable, path: string, cookie: string | null) {
  return app.request(`https://${INSTANCE_HOST}/api/auth/verify`, {
    headers: { ...browserHeaders(cookie), "x-forwarded-uri": path },
  });
}

export async function callHttp(app: Hono, op: HttpOperation, role: Role): Promise<Outcome> {
  const cookie = cookieOf(role);
  const forwarded: Record<string, string> = {};
  if (op.reach === "edge-gated") {
    const verdict = await probe(app, op.path, cookie);
    if (verdict.status >= 300) {
      return { stage: "edge", status: verdict.status, refused: isRefusal(verdict.status) };
    }
    for (const name of PROBE_COPIED_HEADERS) {
      const value = verdict.headers.get(name);
      if (value) forwarded[name.toLowerCase()] = value;
    }
  }
  const hasBody = !["GET", "HEAD", "DELETE"].includes(op.method);
  const response = await withTimeout(
    Promise.resolve(
      app.request(`https://${INSTANCE_HOST}${op.path}`, {
        method: op.method,
        headers: {
          ...browserHeaders(cookie),
          ...forwarded,
          ...(hasBody ? { "content-type": "application/json" } : {}),
        },
        ...(hasBody ? { body: "{}" } : {}),
      }),
    ),
  );
  if (response === "timeout") return { stage: "route", status: "timeout", refused: false };
  // Event streams never end; the status is all the comparison reads.
  await response.body?.cancel().catch(() => {});
  return { stage: "route", status: response.status, refused: isRefusal(response.status) };
}

/** Opens `path` as a WebSocket on a listening instance and reports the handshake. */
export function upgradeStatus(
  port: number,
  path: string,
  cookie: string | null,
  timeoutMs = CALL_TIMEOUT_MS,
): Promise<number | "timeout"> {
  return new Promise((resolve) => {
    const req = httpRequest({
      host: "127.0.0.1",
      port,
      path,
      headers: {
        ...browserHeaders(cookie),
        host: `127.0.0.1:${port}`,
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-version": "13",
        "sec-websocket-key": randomBytes(16).toString("base64"),
      },
    });
    const done = (status: number | "timeout", socket?: Duplex) => {
      clearTimeout(timer);
      socket?.destroy();
      req.destroy();
      resolve(status);
    };
    const timer = setTimeout(() => done("timeout"), timeoutMs);
    req.on("upgrade", (_res, socket) => done(101, socket));
    req.on("response", (res) => {
      res.resume();
      done(res.statusCode ?? 0);
    });
    req.on("error", () => done("timeout"));
    req.end();
  });
}

export async function callUpgrade(
  app: Hono,
  port: number,
  op: UpgradeOperation,
  role: Role,
): Promise<Outcome> {
  const cookie = cookieOf(role);
  if (op.reach === "edge-gated") {
    const verdict = await probe(app, op.path, cookie);
    if (verdict.status >= 300) {
      return { stage: "edge", status: verdict.status, refused: isRefusal(verdict.status) };
    }
  }
  const status = await upgradeStatus(port, op.path, cookie);
  return { stage: "route", status, refused: isRefusal(status) };
}

/**
 * The upgrade handlers on `server` that answer none of `paths` for the
 * guardian, by index. Each handler is tried alone: a handler answers a path
 * when the handshake gets any response while it is the only one attached.
 */
export async function unclaimedUpgradeHandlers(
  server: Server,
  port: number,
  paths: string[],
): Promise<number[]> {
  const handlers = server.listeners("upgrade") as ((...args: unknown[]) => void)[];
  const cookie = cookieOf("guardian");
  const unclaimed: number[] = [];
  try {
    for (const [index, handler] of handlers.entries()) {
      server.removeAllListeners("upgrade");
      server.on("upgrade", handler);
      // The HTTP server keeps sockets half-open, so a socket no handler took
      // would outlive the client's hang-up and hold `server.close()` forever.
      server.on("upgrade", (_req: unknown, socket: Duplex) => {
        socket.on("end", () => socket.destroy());
      });
      const statuses = await Promise.all(
        paths.map((path) => upgradeStatus(port, path, cookie, 1_500)),
      );
      if (statuses.every((status) => status === "timeout")) unclaimed.push(index);
    }
  } finally {
    server.removeAllListeners("upgrade");
    for (const handler of handlers) server.on("upgrade", handler);
  }
  return unclaimed;
}

/** What a browser request reaches: the instance's app, or a stand-in around it. */
export type Browsable = Pick<Hono, "request">;

/** One browser request through the edge, as `callHttp` makes it, with a JSON
 *  body when given. Resolves the probe's refusal when the probe refuses. */
export async function browse(
  app: Browsable,
  init: { method: string; path: string; cookie: string | null; json?: unknown },
): Promise<{ stage: "edge" | "route"; response: Response }> {
  const forwarded: Record<string, string> = {};
  if (reachOf(init.path.split("?")[0]) === "edge-gated") {
    const verdict = await probe(app, init.path, init.cookie);
    if (verdict.status >= 300) return { stage: "edge", response: verdict };
    for (const name of PROBE_COPIED_HEADERS) {
      const value = verdict.headers.get(name);
      if (value) forwarded[name.toLowerCase()] = value;
    }
  }
  const response = await app.request(`https://${INSTANCE_HOST}${init.path}`, {
    method: init.method,
    headers: {
      ...browserHeaders(init.cookie),
      ...forwarded,
      ...(init.json === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(init.json === undefined ? {} : { body: JSON.stringify(init.json) }),
  });
  return { stage: "route", response };
}
