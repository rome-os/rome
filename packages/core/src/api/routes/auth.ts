import { randomUUID } from "node:crypto";
import type { DashboardIdentity } from "@rome/api-types";
import { Hono, type Context } from "hono";
import { deleteCookie, getCookie } from "hono/cookie";
import { and, eq, like, lt } from "drizzle-orm";
import { guardianAuth, settings } from "../../db/schema.js";
import {
  COOKIE_NAME,
  SESSION_HANDOFF_TTL_MS,
  VISITOR_COOKIE_NAME,
  createSessionHandoffToken,
  issueGuardianSession,
  shouldSecureCookie,
  verifyPassword,
  verifySession,
  verifySessionHandoffToken,
} from "../../lib/auth.js";
import { getExternalRequestOrigin } from "../../lib/request-origin.js";
import {
  createSessionHandoffKey,
  SESSION_HANDOFF_KEY_PREFIX,
  type SessionHandoffRecord,
} from "../../lib/session-handoff.js";
import { CLOUD_GUARDIAN_PASSWORD_SENTINEL } from "../../lib/guardian-auth-state.js";
import { isAppApiPathNoAuth } from "../../apps/no-auth.js";
import { resolveGuardianSession } from "../../lib/guardian-session.js";
import { resolveVisitorSession, type RomeAppViewer } from "../../lib/visitor-session.js";
import type { ResolvedApp } from "../../apps/state.js";
import { decodeAppApiPath, decodeAppIdPathSegment, InvalidAppApiPathError } from "../helpers.js";
import type { ApiDeps } from "../deps.js";

// `/api/*` endpoints the Caddy `forward_auth` probe waves through without
// a cookie check — login flow, health/uptime probes, OAuth/MCP callbacks
// that carry their own auth. Patterns ending in `/*` match the prefix +
// any deeper path; bare patterns match exactly.
const PUBLIC_API_PATHS = [
  "/api/auth/*",
  // Subsumed by `/api/auth/*` above, but listed explicitly so the public
  // cloud-login surface is auditable here: the GET callback is a
  // top-level browser navigation back from Rome Cloud and must clear the
  // forward_auth probe without a session cookie.
  "/api/auth/cloud/*",
  "/api/auth/visitor/*",
  "/api/health",
  "/api/health/*",
  "/api/uptime",
  "/api/uptime/*",
  "/api/tailnet",
  "/api/tailnet/*",
  // The unauthenticated SPA bootstrap probe.
  "/api/bootstrap",
  "/api/onboard/*",
  "/api/instance/enroll/*",
  "/api/oauth/*",
  // The connect return leg. The desktop shell hands provider sign-in to the
  // system browser (the Electron window has no platform authenticator, so a
  // passkey second factor cannot complete there), and that browser carries no
  // guardian cookie. Exact path, not a prefix: the rest of /api/setups/* stays
  // private. `state` only correlates the leg back to a setup still parked at
  // `awaiting-redirect` — the credential exchange itself needs the handoff, the
  // PKCE verifier and the instance token, none of which cross this boundary.
  "/api/setups/return",
  // Share Chat — login-free public read of a frozen chat snapshot. The
  // token in the path is the credential; management stays under /api/chat/*.
  "/api/share/*",
];

/**
 * Decide whether the original request (carried in `X-Forwarded-Uri`) is
 * reachable from the public edge without a session cookie.
 *
 * Non-`/api/*` paths — SPA routes (`/dashboard`, `/login`, …), Vite
 * assets, root-mounted surfaces like `/webhooks/*` (X-API-Key auth) and
 * `/app-assets/*` (static) — are all public. The SPA itself handles
 * redirect-to-login on the client when it sees no session.
 *
 * `/api/*` paths default to private; only those listed in
 * `PUBLIC_API_PATHS` are waved through.
 */
function isPublicPath(forwardedUri: string): boolean {
  const path = forwardedUri.split("?")[0];
  if (!path.startsWith("/api/")) return true;
  for (const pattern of PUBLIC_API_PATHS) {
    if (pattern.endsWith("/*")) {
      const base = pattern.slice(0, -2);
      if (path === base || path.startsWith(`${base}/`)) return true;
    } else if (path === pattern) {
      return true;
    }
  }
  return false;
}

function isResolvedApiApp(
  app: unknown,
): app is ResolvedApp & { api: NonNullable<ResolvedApp["api"]> } {
  return (
    !!app &&
    typeof app === "object" &&
    "api" in app &&
    (app as { api: unknown }).api !== null &&
    typeof (app as { api: unknown }).api === "object"
  );
}

/**
 * If `forwardedUri` points at an app-api endpoint (`/api/app-api/<appId>/<sub>`)
 * and the resolved app's manifest declares `api.noAuth` covering `<sub>`,
 * return true so the verify handler can short-circuit to 204 without a
 * cookie. This is the public surface intended for third-party webhooks
 * and callbacks; the dashboard-side `/api/apps/<appId>/*` is intentionally
 * not consulted here — those endpoints always require a session.
 *
 * Returns false for anything that doesn't match the `/api/app-api/` shape
 * or for malformed paths (which fall through to the normal cookie check).
 */
function isAppApiPathPublic(forwardedUri: string, deps: ApiDeps): boolean {
  const path = forwardedUri.split("?")[0];
  const match = path.match(/^\/api\/app-api\/([^/]+)(?:\/(.*))?$/);
  if (!match) return false;

  let appId: string;
  let subPath: string;
  try {
    appId = decodeAppIdPathSegment(match[1]);
    const parts = decodeAppApiPath(match[2]);
    subPath = parts.length === 0 ? "/" : `/${parts.join("/")}`;
  } catch (err) {
    if (err instanceof InvalidAppApiPathError) return false;
    throw err;
  }

  if (deps.publicAccessState.allowedApps().has(appId)) return true;

  const resolved = deps.appCatalog.get(appId);
  if (!isResolvedApiApp(resolved)) return false;
  return isAppApiPathNoAuth(resolved.api.noAuth, subPath);
}

/**
 * If `forwardedUri` targets an app's dashboard-side surface
 * (`/api/apps/<appId>` or `/api/apps/<appId>/*`) and the app is in
 * `publicAccess.allowedApps`, treat it as public. The toggle is
 * user-driven (AppsIndexPage "public" switch) and means "anonymous
 * visitors can use this app's full HTTP surface" — so it covers
 * `/api/apps/<id>/{icon,manifest,...}` and the dispatcher fall-through.
 *
 * Per-path manifest `noAuth` does NOT apply here on purpose — `noAuth`
 * is the public-webhook surface (`/api/app-api/...`), which is governed
 * by `isAppApiPathPublic` above. Mixing the two would silently widen the
 * dashboard surface for any app that declared a noAuth webhook.
 */
function isAppDashboardPathPublic(forwardedUri: string, deps: ApiDeps): boolean {
  const appId = decodeDashboardAppId(forwardedUri);
  return appId !== null && deps.publicAccessState.allowedApps().has(appId);
}

function decodeDashboardAppId(forwardedUri: string): string | null {
  const path = forwardedUri.split("?")[0];
  const match = path.match(/^\/api\/apps\/([^/]+)(?:\/.*)?$/);
  if (!match) return null;

  try {
    return decodeAppIdPathSegment(match[1]);
  } catch (err) {
    if (err instanceof InvalidAppApiPathError) return null;
    throw err;
  }
}

function decodePublicAppApiAppId(forwardedUri: string): string | null {
  const path = forwardedUri.split("?")[0];
  const match = path.match(/^\/api\/app-api\/([^/]+)(?:\/.*)?$/);
  if (!match) return null;

  try {
    return decodeAppIdPathSegment(match[1]);
  } catch (err) {
    if (err instanceof InvalidAppApiPathError) return null;
    throw err;
  }
}

function decodeAppAssetAppId(forwardedUri: string): string | null {
  const path = forwardedUri.split("?")[0];
  const match = path.match(/^\/app-assets\/([^/]+)(?:\/.*)?$/);
  if (!match) return null;

  try {
    return decodeAppIdPathSegment(match[1]);
  } catch (err) {
    if (err instanceof InvalidAppApiPathError) return null;
    throw err;
  }
}

function isAppManifestPath(forwardedUri: string): boolean {
  return /^\/api\/apps\/[^/]+\/manifest(?:\?|$)/.test(forwardedUri);
}

function cloudEmailAccessResult(
  appId: string,
  viewer: RomeAppViewer | null,
  deps: ApiDeps,
): "allowed" | "unauthenticated" | "forbidden" | "not_configured" {
  if (!deps.publicAccessState.isCloudEmailApp(appId)) return "not_configured";
  if (!viewer) return "unauthenticated";
  const allowedEmails = deps.publicAccessState.cloudEmailsForApp(appId);
  return allowedEmails.has(viewer.email.toLowerCase()) ? "allowed" : "forbidden";
}

function dashboardAccessResult(
  viewer: RomeAppViewer | null,
  deps: ApiDeps,
): "allowed" | "unauthenticated" | "forbidden" | "not_configured" {
  if (!deps.dashboardAccessState.hasCloudEmailAccess()) return "not_configured";
  if (!viewer) return "unauthenticated";
  return deps.dashboardAccessState.isCloudEmailAllowed(viewer.email) ? "allowed" : "forbidden";
}

function applyViewerHeaders(c: Context, viewer: RomeAppViewer): void {
  c.header("X-Rome-Visitor-Account-Id", viewer.accountId);
  c.header("X-Rome-Visitor-Email", viewer.email);
}

function resolveGuardianCookieSession(c: Context): { userId: string } | null {
  const token = getCookie(c, COOKIE_NAME);
  return token ? verifySession(token) : null;
}

function applyGuardianHeaders(c: Context, session: { userId: string }): void {
  c.header("X-Rome-User-Id", session.userId);
}

const attempts = new Map<string, { count: number; resetAt: number }>();
const MAX_ATTEMPTS = 5;
const WINDOW_MS = 60_000;

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const entry = attempts.get(ip);

  if (!entry || now > entry.resetAt) {
    attempts.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    return false;
  }

  entry.count++;
  return entry.count > MAX_ATTEMPTS;
}

function normalizeTargetHost(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return null;

  try {
    return new URL(`https://${trimmed}`).hostname;
  } catch {
    return null;
  }
}

function normalizeNextPath(raw: unknown): string {
  if (typeof raw !== "string") return "/onboard";
  return raw.startsWith("/") ? raw : "/onboard";
}

function createTailnetRedirectUrl(targetHost: string, nextPath: string): URL {
  return new URL(nextPath, `https://${targetHost}`);
}

export function authRoutes(deps: ApiDeps): Hono {
  const app = new Hono();

  app.post("/auth/login", async (c) => {
    const ip =
      c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
      c.req.header("x-real-ip") ||
      "unknown";

    if (isRateLimited(ip)) {
      return c.json({ error: "Too many login attempts. Try again later." }, 429);
    }

    const body = await c.req.json<{ userId?: string; password?: string }>().catch(() => null);
    if (!body) {
      return c.json({ error: "Invalid request body" }, 400);
    }

    const { userId, password } = body;
    if (!userId || !password) {
      return c.json({ error: "userId and password are required" }, 400);
    }

    const [record] = await deps.db
      .select()
      .from(guardianAuth)
      .where(eq(guardianAuth.userId, userId))
      .limit(1);

    if (!record) {
      return c.json({ error: "Invalid credentials" }, 401);
    }

    // A cloud-bound seat has no local password — the sentinel
    // is not a bcrypt digest, so `verifyPassword` would reject it anyway, but
    // fail closed explicitly rather than lean on bcrypt's malformed-hash handling.
    if (record.passwordHash === CLOUD_GUARDIAN_PASSWORD_SENTINEL) {
      return c.json({ error: "Invalid credentials" }, 401);
    }

    const valid = await verifyPassword(password, record.passwordHash);
    if (!valid) {
      return c.json({ error: "Invalid credentials" }, 401);
    }

    issueGuardianSession(c, userId);
    return c.json({ success: true });
  });

  app.post("/auth/logout", async (c) => {
    deleteCookie(c, COOKIE_NAME, {
      path: "/",
      secure: shouldSecureCookie(c.req.raw),
      sameSite: "Lax",
    });
    deleteCookie(c, VISITOR_COOKIE_NAME, {
      path: "/",
      secure: shouldSecureCookie(c.req.raw),
      sameSite: "Lax",
    });
    return c.json({ success: true });
  });

  // The dashboard's "who am I" probe: which of the two authenticated
  // identities (guardian or dashboard visitor) this request carries, plus the
  // display fields the shell renders (profile menu). Guardian wins when both
  // cookies are present, mirroring the app-api caller resolution. Public path
  // (under /api/auth/*): an unauthenticated caller gets `anonymous`, not 401.
  app.get("/auth/me", async (c) => {
    const session = await resolveGuardianSession(c, deps.db);
    if (session) {
      const guardianName = await deps.settingsRepo.get("guardianName");
      const [guardian] = await deps.db
        .select({ avatarUrl: guardianAuth.avatarUrl })
        .from(guardianAuth)
        .limit(1);
      const identity: DashboardIdentity = {
        kind: "guardian",
        userId: session.userId,
        displayName: typeof guardianName === "string" && guardianName ? guardianName : null,
        avatarUrl: guardian?.avatarUrl ?? null,
      };
      return c.json(identity);
    }

    const visitor = resolveVisitorSession(c);
    if (visitor && deps.dashboardAccessState.isCloudEmailAllowed(visitor.email)) {
      const identity: DashboardIdentity = {
        kind: "visitor",
        accountId: visitor.accountId,
        email: visitor.email,
        avatarUrl: visitor.avatarUrl ?? null,
      };
      return c.json(identity);
    }

    const identity: DashboardIdentity = { kind: "anonymous" };
    return c.json(identity);
  });

  // Probe endpoint for Caddy `forward_auth`. The Caddyfile sends every
  // proxied request here first; we return 204 (with `X-Rome-User-Id` copied
  // forward) or 401, and Caddy decides whether to proxy or reject.
  //
  // The original request path arrives in `X-Forwarded-Uri` (set by Caddy on
  // the sub-request). Paths in `PUBLIC_API_PATHS` short-circuit to 204 with
  // no cookie check — login flow, health/uptime probes, OAuth callbacks,
  // X-API-Key-protected webhooks, and installed-app static assets all
  // self-authenticate or don't need it. Everything else requires a valid
  // session cookie.
  //
  // Direct (non-probe) calls to `/auth/verify` have no `X-Forwarded-Uri` and
  // fall through to the cookie check — effectively "am I logged in" with a
  // userId-in-header response.
  app.get("/auth/verify", async (c) => {
    const forwardedUri = c.req.header("X-Forwarded-Uri") ?? "";
    let guardianSession: { userId: string } | null | undefined;
    const getGuardianSession = () => {
      if (guardianSession === undefined) {
        guardianSession = resolveGuardianCookieSession(c);
      }
      return guardianSession;
    };
    let visitorSession: RomeAppViewer | null | undefined;
    const getVisitorSession = () => {
      if (visitorSession === undefined) {
        visitorSession = resolveVisitorSession(c);
      }
      return visitorSession;
    };
    const allowGuardianSession = () => {
      const session = getGuardianSession();
      if (!session) return false;
      applyGuardianHeaders(c, session);
      return true;
    };
    const allowDashboardCloudEmailSession = () => {
      const viewer = getVisitorSession();
      if (dashboardAccessResult(viewer, deps) !== "allowed" || !viewer) {
        return false;
      }
      applyViewerHeaders(c, viewer);
      return true;
    };
    const allowFullDashboardSession = () =>
      allowGuardianSession() || allowDashboardCloudEmailSession();

    if (forwardedUri) {
      const assetAppId = decodeAppAssetAppId(forwardedUri);
      if (
        assetAppId &&
        !deps.publicAccessState.allowedApps().has(assetAppId) &&
        deps.publicAccessState.isCloudEmailApp(assetAppId)
      ) {
        if (allowFullDashboardSession()) return c.body(null, 204);
        const viewer = getVisitorSession();
        const result = cloudEmailAccessResult(assetAppId, viewer, deps);
        if (result === "allowed" && viewer) {
          applyViewerHeaders(c, viewer);
          return c.body(null, 204);
        }
        if (result === "forbidden") return c.json({ error: "Forbidden" }, 403);
        if (result === "unauthenticated") {
          return c.json({ error: "Visitor authentication required" }, 401);
        }
      }
    }

    if (forwardedUri && isPublicPath(forwardedUri)) {
      return c.body(null, 204);
    }

    if (forwardedUri && isAppApiPathPublic(forwardedUri, deps)) {
      return c.body(null, 204);
    }

    if (forwardedUri && isAppDashboardPathPublic(forwardedUri, deps)) {
      return c.body(null, 204);
    }

    if (forwardedUri) {
      const dashboardAppId = decodeDashboardAppId(forwardedUri);
      if (
        dashboardAppId &&
        deps.publicAccessState.isCloudEmailApp(dashboardAppId) &&
        isAppManifestPath(forwardedUri)
      ) {
        return c.body(null, 204);
      }

      const appId = dashboardAppId ?? decodePublicAppApiAppId(forwardedUri);
      if (appId && deps.publicAccessState.isCloudEmailApp(appId)) {
        if (allowFullDashboardSession()) return c.body(null, 204);
        const viewer = getVisitorSession();
        const result = cloudEmailAccessResult(appId, viewer, deps);
        if (result === "allowed" && viewer) {
          applyViewerHeaders(c, viewer);
          return c.body(null, 204);
        }
        if (result === "forbidden") {
          return c.json({ error: "Forbidden" }, 403);
        }
        if (result === "unauthenticated") {
          return c.json({ error: "Visitor authentication required" }, 401);
        }
      }
    }

    if (forwardedUri && deps.dashboardAccessState.hasCloudEmailAccess()) {
      if (allowFullDashboardSession()) return c.body(null, 204);
      const result = dashboardAccessResult(getVisitorSession(), deps);
      if (result === "forbidden") {
        return c.json({ error: "Forbidden" }, 403);
      }
      if (result === "unauthenticated") {
        return c.json({ error: "Visitor authentication required" }, 401);
      }
    }

    const session = getGuardianSession();
    if (!session) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    applyGuardianHeaders(c, session);
    return c.body(null, 204);
  });

  app.post("/auth/handoff-token", async (c) => {
    const sessionToken = getCookie(c, COOKIE_NAME);
    if (!sessionToken) {
      return c.json({ error: "Not authenticated" }, 401);
    }

    const session = verifySession(sessionToken);
    if (!session) {
      return c.json({ error: "Invalid session" }, 401);
    }

    const body = await c.req.json<{ targetHost?: unknown; next?: unknown }>().catch(() => null);
    if (!body) {
      return c.json({ error: "Invalid request body" }, 400);
    }

    const targetHost = normalizeTargetHost(body.targetHost);
    if (!targetHost) {
      return c.json({ error: "A valid targetHost is required" }, 400);
    }

    const nextPath = normalizeNextPath(body.next);
    const nonce = randomUUID();
    const now = new Date();

    await deps.db
      .delete(settings)
      .where(
        and(
          like(settings.key, `${SESSION_HANDOFF_KEY_PREFIX}%`),
          lt(settings.updatedAt, new Date(Date.now() - SESSION_HANDOFF_TTL_MS)),
        ),
      );

    await deps.db.insert(settings).values({
      key: createSessionHandoffKey(nonce),
      value: { userId: session.userId, targetHost },
      updatedAt: now,
    });

    return c.json({
      token: createSessionHandoffToken({
        userId: session.userId,
        targetHost,
        nonce,
      }),
      targetHost,
      next: nextPath,
    });
  });

  app.post("/auth/handoff", async (c) => {
    const externalOrigin = getExternalRequestOrigin(c.req.raw);
    const form = await c.req.formData();
    const handoffToken = form.get("token");
    if (typeof handoffToken !== "string" || !handoffToken) {
      return c.redirect("/login", 303);
    }

    const claims = verifySessionHandoffToken(handoffToken);
    if (!claims || claims.targetHost !== externalOrigin.hostname) {
      return c.redirect("/login", 303);
    }

    const handoffKey = createSessionHandoffKey(claims.nonce);
    const [row] = await deps.db
      .select()
      .from(settings)
      .where(eq(settings.key, handoffKey))
      .limit(1);

    if (!row) {
      return c.redirect("/login", 303);
    }

    const nextPath = normalizeNextPath(form.get("next"));
    const record = row.value as SessionHandoffRecord | undefined;
    const isExpired = row.updatedAt.getTime() < Date.now() - SESSION_HANDOFF_TTL_MS;
    const matchesRecord =
      record?.userId === claims.userId && record?.targetHost === claims.targetHost;

    await deps.db.delete(settings).where(eq(settings.key, handoffKey));

    if (isExpired || !matchesRecord) {
      return c.redirect("/login", 303);
    }

    issueGuardianSession(c, claims.userId);

    return c.redirect(createTailnetRedirectUrl(claims.targetHost, nextPath).toString(), 303);
  });

  return app;
}
