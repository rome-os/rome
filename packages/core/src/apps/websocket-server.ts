import type { Server, IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, WebSocket, type RawData } from "ws";
import type {
  AppRuntimeRepositories,
  RomeAppWebSocket,
  RomeAppWebSocketHandlers,
} from "@rome-os/app-runtime";
import { createLogger } from "../logger.js";
import { AppApiDispatcher, type RomeAppApiRequest, type RomeAppCaller } from "./api.js";
import type { AppCatalog } from "./catalog.js";
import type { ActionEngine } from "../actions/engine.js";
import type { DrizzleDb } from "../db/index.js";
import type { RoutinesRepository } from "../db/repositories/routines.js";
import { decodeAppApiPath, decodeAppIdPathSegment } from "../api/helpers.js";
import { isSameOriginMutationRequest } from "../lib/mutation-origin.js";
import { stripInternalHeaders } from "../relay/protocol.js";
import { COOKIE_NAME, VISITOR_COOKIE_NAME, verifyVisitorSession } from "../lib/auth.js";
import { resolveGuardianSessionFromMaterial } from "../lib/guardian-session.js";
import { readCookie, rejectUpgrade, toOriginRequest } from "../lib/ws-upgrade.js";
import {
  enrichGuardianActor,
  runWithSessionActor,
  type SessionActor,
} from "../lib/session-actor.js";
import type { RomeAppViewer } from "../lib/visitor-session.js";
import type { FavorService } from "../favors/types.js";

const log = createLogger("app-websocket");

/**
 * Global-registry symbol mirroring `@rome-os/app-runtime`'s `upgradeWebSocket`.
 * The host stashes an `accept` bridge under this key on the dispatched request;
 * the SDK helper reads it back. `Symbol.for` is what lets the two packages share
 * one symbol identity.
 */
const WS_UPGRADE_ACCEPT = Symbol.for("rome-os.app-runtime.ws.accept");

const MAX_CONNECTIONS_PER_APP = 64;
/** Reject frames larger than this (bytes). */
const MAX_MESSAGE_BYTES = 1024 * 1024;
/** Keepalive ping cadence — short enough to beat reverse-proxy idle timeouts. */
const PING_INTERVAL_MS = 30_000;
/** Close code used when an app is reloaded/uninstalled out from under a connection. */
const CLOSE_CODE_APP_RELOADED = 1012; // Service Restart

/** Subset of `ApiDeps` this module needs — kept minimal to avoid an import cycle. */
export interface AppWebSocketDeps {
  appCatalog: AppCatalog;
  db: DrizzleDb;
  actionEngine: ActionEngine;
  routinesRepo?: RoutinesRepository;
  appRuntimeRepositories: AppRuntimeRepositories;
  favorService?: FavorService;
}

interface MatchedPath {
  appId: string;
  appPath: string[];
}

/** Match `/api/apps/:id/*` and `/api/app-api/:id/*`; null if neither. */
function matchAppPath(pathname: string): MatchedPath | null {
  const match =
    pathname.match(/^\/api\/apps\/([^/]+)(?:\/(.*))?$/) ??
    pathname.match(/^\/api\/app-api\/([^/]+)(?:\/(.*))?$/);
  if (!match) return null;
  try {
    return { appId: decodeAppIdPathSegment(match[1]), appPath: decodeAppApiPath(match[2]) };
  } catch {
    return null;
  }
}

function resolveWsViewer(req: IncomingMessage): RomeAppViewer | undefined {
  const token = readCookie(req.headers.cookie, VISITOR_COOKIE_NAME);
  const session = token ? verifyVisitorSession(token) : null;
  if (!session) return undefined;
  return {
    accountId: session.accountId,
    email: session.email,
    favorViewerToken: session.favorViewerToken,
  };
}

/**
 * Resolve the upgrade's caller identity from the same primary material as the
 * HTTP dispatch path (guardian cookie or trusted loopback; visitor cookie) —
 * see `RomeAppCaller`. Guardian wins over a coexisting visitor session.
 */
async function resolveWsCaller(
  req: IncomingMessage,
  viewer: RomeAppViewer | undefined,
  db: DrizzleDb,
): Promise<RomeAppCaller> {
  const guardian = await resolveGuardianSessionFromMaterial(
    {
      sessionToken: readCookie(req.headers.cookie, COOKIE_NAME),
      hasForwardedFor: Boolean(req.headers["x-forwarded-for"]),
      peerAddress: req.socket.remoteAddress ?? undefined,
    },
    db,
  );
  if (guardian) return { kind: "guardian", userId: guardian.userId, via: guardian.via };
  if (viewer) return { kind: "visitor", accountId: viewer.accountId, email: viewer.email };
  return { kind: "anonymous" };
}

/** Widen the resolved caller into the audit-grade actor stamped on action
 * executions (guardian gains the seat's accountId/email enrichment). */
async function toSessionActor(caller: RomeAppCaller, db: DrizzleDb): Promise<SessionActor> {
  if (caller.kind === "guardian") {
    return enrichGuardianActor(db, { userId: caller.userId, via: caller.via });
  }
  if (caller.kind === "visitor") {
    return { kind: "visitor", accountId: caller.accountId, email: caller.email };
  }
  return { kind: "anonymous" };
}

function headersToRecord(headers: IncomingMessage["headers"]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    out[key] = Array.isArray(value) ? value.join(", ") : value;
  }
  return out;
}

function toMessageData(raw: RawData, isBinary: boolean): string | Uint8Array {
  if (!isBinary) return raw.toString();
  if (Array.isArray(raw)) return new Uint8Array(Buffer.concat(raw));
  if (Buffer.isBuffer(raw)) return new Uint8Array(raw);
  return new Uint8Array(raw as ArrayBuffer);
}

/**
 * Attaches app WebSocket support to the raw HTTP server. WebSocket upgrades
 * bypass `app.fetch` entirely (Node routes them through the `upgrade` event), so
 * this is the only seam where an upgrade for an app path can be turned back into
 * a normal `handle(request)` dispatch. The app accepts the upgrade by calling
 * `upgradeWebSocket(request, handlers)` from `@rome-os/app-runtime`; everything
 * below — the socket, the handshake, the registry, teardown — stays host-side.
 */
export function attachAppWebSocket(server: Server, deps: AppWebSocketDeps): { close(): void } {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });
  const dispatcher = new AppApiDispatcher(deps.appCatalog, {
    db: deps.db,
    actionEngine: deps.actionEngine,
    routinesRepo: deps.routinesRepo,
    repositories: deps.appRuntimeRepositories,
    favorService: deps.favorService,
  });

  // Live connections, keyed by appId, so a catalog change can close them all.
  const byApp = new Map<string, Set<WebSocket>>();
  // Slots reserved while a handshake is in flight but not yet registered in
  // `byApp`. The cap is checked against live + reserved so concurrent upgrades
  // can't all slip past it across the `await dispatch` boundary (TOCTOU).
  const reserved = new Map<string, number>();

  /** Reserve a connection slot if under the cap. Returns false if at capacity. */
  function reserveSlot(appId: string): boolean {
    const live = byApp.get(appId)?.size ?? 0;
    const pending = reserved.get(appId) ?? 0;
    if (live + pending >= MAX_CONNECTIONS_PER_APP) return false;
    reserved.set(appId, pending + 1);
    return true;
  }

  /** Release a reservation once the handshake resolves (accepted or not). */
  function releaseSlot(appId: string): void {
    const pending = reserved.get(appId) ?? 0;
    if (pending <= 1) reserved.delete(appId);
    else reserved.set(appId, pending - 1);
  }

  function register(appId: string, ws: WebSocket): void {
    let set = byApp.get(appId);
    if (!set) {
      set = new Set();
      byApp.set(appId, set);
    }
    set.add(ws);
    ws.once("close", () => {
      const current = byApp.get(appId);
      if (!current) return;
      current.delete(ws);
      if (current.size === 0) byApp.delete(appId);
    });
  }

  // Invariant: app disable / uninstall / hot-reload closes its live sockets — a
  // connection must never outlive the module instance that owns its handlers.
  // "added" can't have live connections yet, so it's a no-op.
  const unsubscribe = deps.appCatalog.subscribe((event) => {
    if (event.change === "added") return;
    const set = byApp.get(event.appId);
    if (!set) return;
    for (const ws of [...set]) {
      try {
        ws.close(CLOSE_CODE_APP_RELOADED, "app reloaded");
      } catch {
        /* already closing */
      }
    }
  });

  // `actor` is the session identity captured at upgrade time. Socket events
  // fire from I/O outside the upgrade's async scope (AsyncLocalStorage does
  // not follow EventEmitter callbacks), so each handler invocation re-enters
  // the actor scope explicitly — actions run from WS handlers stay attributed.
  function wireConnection(
    appId: string,
    ws: WebSocket,
    handlers: RomeAppWebSocketHandlers,
    actor: SessionActor,
  ): void {
    register(appId, ws);

    const facade: RomeAppWebSocket = {
      send(data) {
        if (ws.readyState === WebSocket.OPEN) ws.send(data);
      },
      close(code, reason) {
        ws.close(code, reason);
      },
      get readyState() {
        return ws.readyState;
      },
    };

    const pingTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.ping();
    }, PING_INTERVAL_MS);

    ws.on("message", (raw: RawData, isBinary: boolean) => {
      runWithSessionActor(actor, () =>
        Promise.resolve(handlers.message?.(facade, toMessageData(raw, isBinary))),
      ).catch((err) => {
        log.warn("app ws message handler threw", { appId, error: errMessage(err) });
      });
    });
    ws.on("close", (code: number, reason: Buffer) => {
      clearInterval(pingTimer);
      runWithSessionActor(actor, () =>
        Promise.resolve(handlers.close?.(code, reason.toString())),
      ).catch((err) => {
        log.warn("app ws close handler threw", { appId, error: errMessage(err) });
      });
    });
    ws.on("error", (err: Error) => {
      try {
        handlers.error?.(err);
      } catch {
        /* swallow — the connection is already failing */
      }
    });

    runWithSessionActor(actor, () => Promise.resolve(handlers.open?.(facade))).catch((err) => {
      log.warn("app ws open handler threw", { appId, error: errMessage(err) });
      ws.close(1011, "open handler failed");
    });
  }

  async function handleUpgrade(
    matched: MatchedPath,
    query: URLSearchParams,
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): Promise<void> {
    // Reserve eagerly, before the `await` below: `accept`'s `handleUpgrade`
    // callback registers the socket synchronously, so the reservation only has
    // to bridge the dispatch yield. Released in `finally` once the outcome is known.
    if (!reserveSlot(matched.appId)) {
      rejectUpgrade(socket, 503, "Too Many Connections");
      return;
    }

    // The host's bridge: calling it performs the handshake and wires the app's
    // handlers. Flag tells us afterwards whether the app actually accepted.
    // `actor` is assigned before dispatch (which is what invokes `accept`).
    let accepted = false;
    let actor: SessionActor = { kind: "anonymous" };
    const accept = (handlers: RomeAppWebSocketHandlers): Response => {
      accepted = true;
      wss.handleUpgrade(req, socket, head, (ws) => {
        wireConnection(matched.appId, ws, handlers, actor);
      });
      // The handler returns this; the upgrade outcome is tracked via `accepted`,
      // so the body/status are irrelevant (a real 101 can't be a fetch Response).
      return new Response(null, { status: 200 });
    };

    // Same identity hygiene as the HTTP dispatch path (api/routes/app-api.ts):
    // forwarded identity headers are untrustworthy on public surfaces, so they
    // are removed and replaced by the resolved `caller`.
    const headers = headersToRecord(req.headers);
    stripInternalHeaders(headers);
    delete headers["x-rome-user-id"];
    delete headers["x-rome-visitor-account-id"];
    delete headers["x-rome-visitor-email"];
    const viewer = resolveWsViewer(req);

    // Fail closed with a clean handshake rejection: a resolution error must
    // not hand the app an unresolved identity (or destroy the socket without
    // a response).
    let caller: RomeAppCaller;
    try {
      caller = await resolveWsCaller(req, viewer, deps.db);
      actor = await toSessionActor(caller, deps.db);
    } catch (err) {
      log.warn("app ws caller resolution failed", {
        appId: matched.appId,
        error: errMessage(err),
      });
      rejectUpgrade(socket, 500, "Internal Server Error");
      releaseSlot(matched.appId);
      return;
    }

    const request: RomeAppApiRequest & {
      [WS_UPGRADE_ACCEPT]: (h: RomeAppWebSocketHandlers) => Response;
    } = {
      method: req.method ?? "GET",
      path: matched.appPath,
      headers,
      query,
      caller,
      [WS_UPGRADE_ACCEPT]: accept,
    };

    try {
      // Ambient for the upgrade dispatch, so an action run from the app's
      // upgrade handler is attributed to the connecting session.
      await runWithSessionActor(actor, () =>
        dispatcher.dispatch(matched.appId, request, { viewer }),
      );
    } catch (err) {
      if (!accepted) {
        log.warn("app ws dispatch failed", { appId: matched.appId, error: errMessage(err) });
        rejectUpgrade(socket, 404, "Not Found");
      }
      return;
    } finally {
      // By now the socket (if accepted) is registered in `byApp`, so the
      // reservation has handed off to the live count.
      releaseSlot(matched.appId);
    }

    if (!accepted) {
      // Handler returned a normal Response without calling upgradeWebSocket().
      rejectUpgrade(socket, 426, "Upgrade Required");
    }
  }

  function onUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const matched = matchAppPath(url.pathname);
    if (!matched) return; // not an app path — leave it for other upgrade listeners

    // App WS paths are cookie-gated by Caddy's forward_auth, and browsers attach
    // cookies to cross-origin WS handshakes (CORS doesn't apply), so without a
    // same-origin check any page could open an authenticated connection (CSWSH).
    // Mirror the HTTP mutation guard — same X-Forwarded-aware origin rebuild.
    if (!isSameOriginMutationRequest(toOriginRequest(req))) {
      log.warn("rejected cross-origin app ws upgrade", {
        appId: matched.appId,
        origin: req.headers.origin ?? null,
      });
      rejectUpgrade(socket, 403, "Forbidden");
      return;
    }

    handleUpgrade(matched, url.searchParams, req, socket, head).catch((err) => {
      log.error("app ws upgrade crashed", { error: errMessage(err) });
      try {
        socket.destroy();
      } catch {
        /* already gone */
      }
    });
  }

  server.on("upgrade", onUpgrade);

  return {
    close() {
      unsubscribe();
      server.off("upgrade", onUpgrade);
      for (const set of byApp.values()) {
        for (const ws of [...set]) {
          try {
            ws.close(CLOSE_CODE_APP_RELOADED, "server shutting down");
          } catch {
            /* already closing */
          }
        }
      }
      byApp.clear();
      wss.close();
    },
  };
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
