import type { Context } from "hono";
import { Hono } from "hono";
import { createLogger } from "../../logger.js";
import { AppApiDispatcher, type RomeAppCaller } from "../../apps/api.js";
import { InvalidAppApiPathError, decodeAppApiPath, decodeAppIdPathSegment } from "../helpers.js";
import type { ApiDeps } from "../deps.js";
import { stripInternalHeaders } from "../../relay/protocol.js";
import { resolveGuardianSession } from "../../lib/guardian-session.js";
import { resolveVisitorSession } from "../../lib/visitor-session.js";

type AppApiEnv = Record<string, never>;

const log = createLogger("api:app-api");

interface ParsedAppApiRequest {
  appId: string;
  appPath: string[];
  subPath: string;
}

function parseAppApiPath(rawAppId: string, rawRest: string | undefined): ParsedAppApiRequest {
  const appId = decodeAppIdPathSegment(rawAppId);
  const appPath = decodeAppApiPath(rawRest);
  const subPath = appPath.length === 0 ? "/" : `/${appPath.join("/")}`;
  return { appId, appPath, subPath };
}

function buildDispatcher(deps: ApiDeps): AppApiDispatcher {
  return new AppApiDispatcher(deps.appCatalog, {
    db: deps.db,
    actionEngine: deps.actionEngine,
    routinesRepo: deps.routinesRepo,
    repositories: deps.appRuntimeRepositories,
    favorService: deps.favorService,
    appConnections: deps.appConnections,
  });
}

async function dispatchRequest(
  dispatcher: AppApiDispatcher,
  deps: ApiDeps,
  c: Context<AppApiEnv>,
  parsed: ParsedAppApiRequest,
): Promise<Response> {
  const rawHeaders: Record<string, string> = {};
  c.req.raw.headers.forEach((value, key) => {
    rawHeaders[key] = value;
  });
  // `x-rome-internal-*` headers are reserved for in-process callers (e.g. the
  // relay drainer marking a buffered-late delivery). Strip them from this public
  // edge so an external caller can't forge one and bypass a handler's checks.
  stripInternalHeaders(rawHeaders);
  delete rawHeaders["x-rome-visitor-account-id"];
  delete rawHeaders["x-rome-visitor-email"];
  // On a public app the edge waves the request through without touching
  // identity headers, so a client-supplied `X-Rome-User-Id` would arrive
  // verbatim. Handlers must never see it — `request.caller` below is the
  // resolved, trustworthy identity.
  delete rawHeaders["x-rome-user-id"];

  const url = new URL(c.req.url);
  const method = c.req.method;
  const viewer = resolveVisitorSession(c) ?? undefined;
  // Resolve the caller once, host-side, from primary material (guardian
  // cookie or trusted loopback peer; visitor cookie) — never from forwarded
  // headers. Guardian wins over a coexisting visitor session; the visitor
  // session itself stays in the dispatch context for the favors capability.
  const guardian = await resolveGuardianSession(c, deps.db);
  const caller: RomeAppCaller = guardian
    ? { kind: "guardian", userId: guardian.userId, via: guardian.via }
    : viewer
      ? { kind: "visitor", accountId: viewer.accountId, email: viewer.email }
      : { kind: "anonymous" };

  let body: Uint8Array | undefined;
  if (method !== "GET" && method !== "HEAD") {
    const buffer = await c.req.arrayBuffer();
    if (buffer.byteLength > 0) {
      body = new Uint8Array(buffer);
    }
  }

  try {
    return await dispatcher.dispatch(
      parsed.appId,
      {
        method,
        path: parsed.appPath,
        headers: rawHeaders,
        query: url.searchParams,
        body,
        caller,
      },
      { viewer },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status =
      err instanceof InvalidAppApiPathError
        ? 400
        : message.includes("Unknown app") || message.includes("does not declare an API entrypoint")
          ? 404
          : 500;
    log.error("app api dispatch failed", {
      appId: parsed.appId,
      path: parsed.subPath,
      error: message,
    });
    return c.json(
      {
        error: err instanceof InvalidAppApiPathError ? "invalid_app_api_path" : "app_api_error",
        appId: parsed.appId,
        message,
      },
      status,
    );
  }
}

function respondPathError(c: Context<AppApiEnv>, err: unknown, appId: string | null): Response {
  if (err instanceof InvalidAppApiPathError) {
    const payload: { error: string; appId?: string; message: string } = {
      error: "invalid_app_api_path",
      message: err.message,
    };
    if (appId) payload.appId = appId;
    return c.json(payload, 400);
  }
  throw err;
}

/**
 * Public app-api surface mounted at `/api/app-api/<appId>/*`. Auth is
 * enforced at the Caddy edge via `forward_auth` → `/api/auth/verify`;
 * the verify handler consults the resolved app's `api.noAuth` declaration
 * and short-circuits to 204 for covered sub-paths, so this dispatcher
 * doesn't need to do its own cookie check — by the time a request reaches
 * here it has already cleared the edge (or come from inside the container).
 */
export function appApiPublicRoutes(deps: ApiDeps): Hono<AppApiEnv> {
  const app = new Hono<AppApiEnv>();
  const dispatcher = buildDispatcher(deps);

  app.all("/app-api/*", async (c) => {
    const match = c.req.path.match(/\/app-api\/([^/]+)(?:\/(.*))?$/);
    if (!match) return c.json({ error: "Not found" }, 404);

    let parsed: ParsedAppApiRequest;
    try {
      parsed = parseAppApiPath(match[1], match[2]);
    } catch (err) {
      return respondPathError(c, err, null);
    }

    return dispatchRequest(dispatcher, deps, c, parsed);
  });

  return app;
}

/**
 * Dashboard / app-UI surface mounted at `/api/apps/:appId/*`. Mounted BELOW
 * the static `/api/apps/:appId/{icon,manifest,...}` handlers in `appsRoutes`
 * so those static endpoints win for their reserved sub-paths; everything
 * else falls through to the app's API entrypoint.
 */
export function appApiDashboardRoutes(deps: ApiDeps): Hono<AppApiEnv> {
  const app = new Hono<AppApiEnv>();
  const dispatcher = buildDispatcher(deps);

  app.all("/apps/:appId/*", async (c) => {
    const rawAppId = c.req.param("appId");
    const match = c.req.path.match(/\/apps\/[^/]+(?:\/(.*))?$/);
    let parsed: ParsedAppApiRequest;
    try {
      parsed = parseAppApiPath(encodeURIComponent(rawAppId), match?.[1]);
    } catch (err) {
      return respondPathError(c, err, rawAppId);
    }
    return dispatchRequest(dispatcher, deps, c, parsed);
  });

  return app;
}
