// The dashboard surface the verifier calls: every HTTP route in the running
// app's route table that the public edge serves, and every WebSocket upgrade
// path a handler on the running server answers.
//
// Which paths the edge serves, and which of them pass the `forward_auth`
// probe, is read from the Caddyfile Rome generates, so the scope follows the
// production edge rather than a list kept here.

import type { Hono } from "hono";
import { NODE_CONSOLE_PATH } from "@rome/api-types/node-console";
import { VOICE_INPUT_SOCKET_PATH } from "@rome/api-types/voice-input";
import { VOICE_CONVERSATION_SOCKET_PATH } from "@rome/api-types/voice-conversation";
import { generateCaddyfile } from "../../lib/caddyfile-generator.js";
import type { SeededIds } from "./instance.js";

/** How a request reaches Rome from outside. */
export type Reach =
  /** Proxied after the `forward_auth` probe (`/api/auth/verify`) admits it. */
  | "edge-gated"
  /** Proxied straight through, as the WebSocket and app-document paths are. */
  | "edge-open"
  /** Outside the scope: a machine credential surface (`/webhooks`). */
  | "machine"
  /** Outside the scope: no edge matcher proxies it, so only loopback reaches it. */
  | "loopback-only";

export interface HttpOperation {
  kind: "http";
  /** The route as the route table names it, such as `GET /api/approvals/:id`. */
  route: string;
  method: string;
  /** The route pattern with its parameters filled. */
  path: string;
  reach: Reach;
}

export interface UpgradeOperation {
  kind: "ws";
  route: string;
  path: string;
  reach: Reach;
}

export type Operation = HttpOperation | UpgradeOperation;

interface EdgeMatchers {
  gated: string[];
  open: string[];
}

function readEdgeMatchers(caddyfile: string = generateCaddyfile()): EdgeMatchers {
  const matcher = (name: string): string[] => {
    const line = caddyfile.split("\n").find((l) => l.trim().startsWith(`@${name} path `));
    if (!line) throw new Error(`Caddyfile has no @${name} path matcher`);
    return line.trim().slice(`@${name} path `.length).split(/\s+/);
  };
  return {
    gated: matcher("dynamic"),
    open: [...matcher("wsUpgrade"), ...matcher("appDocs")],
  };
}

// Caddy's path matcher: `/x/*` matches `/x/` and anything under it, a bare
// pattern matches exactly.
function caddyMatches(pattern: string, path: string): boolean {
  if (pattern.endsWith("/*")) return path.startsWith(pattern.slice(0, -1));
  return path === pattern;
}

export function reachOf(path: string, edge: EdgeMatchers = readEdgeMatchers()): Reach {
  if (path === "/webhooks" || path.startsWith("/webhooks/")) return "machine";
  if (edge.gated.some((p) => caddyMatches(p, path))) return "edge-gated";
  if (edge.open.some((p) => caddyMatches(p, path))) return "edge-open";
  return "loopback-only";
}

/** The seeded record a route parameter names, so the route reaches a real one. */
function paramValue(name: string, pattern: string, ids: SeededIds): string {
  const under = (segment: string) => pattern.includes(`/${segment}/`);
  if (["chatId", "sessionId"].includes(name)) return ids.chatId;
  if (name === "routineId") return ids.routineId;
  if (name === "id") {
    if (under("approvals")) return ids.approvalId;
    if (under("routines")) return ids.routineId;
    if (under("sessions") || under("chats")) return ids.chatId;
    if (under("people") || under("persons")) return ids.personId;
    if (under("action-executions") || under("executions")) return ids.executionId;
    if (under("sentinel-log")) return ids.sentinelId;
  }
  if (name === "personId") return ids.personId;
  return `verifier-${name}`;
}

export function fillPattern(pattern: string, ids: SeededIds): string {
  return pattern
    .split("/")
    .map((segment) => {
      if (segment === "*") return "verifier";
      if (!segment.startsWith(":")) return segment;
      const name = segment
        .slice(1)
        .replace(/\{.*\}$/, "")
        .replace(/\?$/, "");
      return encodeURIComponent(paramValue(name, pattern, ids));
    })
    .join("/");
}

/**
 * Every operation in the app's route table, one per method and pattern.
 * `ALL` entries are middleware or catch-all handlers, called with GET.
 */
export function httpOperations(app: Hono, ids: SeededIds): HttpOperation[] {
  const edge = readEdgeMatchers();
  const seen = new Set<string>();
  const operations: HttpOperation[] = [];
  for (const entry of app.routes) {
    const method = entry.method === "ALL" ? "GET" : entry.method;
    const route = `${entry.method} ${entry.path}`;
    if (seen.has(route)) continue;
    seen.add(route);
    const path = fillPattern(entry.path, ids);
    operations.push({ kind: "http", route, method, path, reach: reachOf(path, edge) });
  }
  return operations;
}

/**
 * The upgrade paths the verifier knows. A handler on the running server that
 * answers none of them is reported by `unclaimedUpgradeHandlers`, so a new
 * WebSocket surface cannot go uncalled.
 */
export function upgradeOperations(): UpgradeOperation[] {
  const edge = readEdgeMatchers();
  const paths = [
    "/ws/terminal",
    "/ws/events",
    NODE_CONSOLE_PATH,
    VOICE_INPUT_SOCKET_PATH,
    VOICE_CONVERSATION_SOCKET_PATH,
    "/desktop-proxy/verifier",
    "/api/apps/verifier-app/ws",
    "/api/app-api/verifier-app/ws",
  ];
  return paths.map((path) => ({
    kind: "ws",
    route: `WS ${path}`,
    path,
    reach: reachOf(path, edge),
  }));
}
