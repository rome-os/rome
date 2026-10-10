import { randomBytes } from "node:crypto";
import { createPkce } from "@rome-os/libs/pkce";
import { hostname } from "node:os";
import { deleteCookie } from "hono/cookie";
import { Hono, type Context } from "hono";
import { VISITOR_COOKIE_NAME, issueVisitorSession, shouldSecureCookie } from "../../lib/auth.js";
import { normalizePublicAccessEmail } from "../../lib/public-access-config.js";
import { isValidAppId } from "../../apps/packaging/app-id.js";
import { getInstanceOrigin, getRomeCloudOrigin } from "../../lib/rome-cloud-origin.js";
import { createLogger } from "../../logger.js";
import type { ApiDeps } from "../deps.js";

const log = createLogger("api:visitor-auth");

const CALLBACK_PATH = "/api/auth/visitor/callback";
const PENDING_TTL_MS = 10 * 60_000;

type PendingVisitorLogin =
  | {
      scope: "app";
      appId: string;
      next: string;
      verifier: string;
      expiresAt: number;
    }
  | {
      scope: "dashboard";
      next: string;
      verifier: string;
      expiresAt: number;
    };

type PendingVisitorLoginDraft =
  | { scope: "app"; appId: string; next: string }
  | { scope: "dashboard"; next: string };

interface AccountSessionResponse {
  accountId?: unknown;
  email?: unknown;
  avatarUrl?: unknown;
  favorViewerToken?: unknown;
}

export interface VisitorAuthSeams {
  fetchImpl?: typeof fetch;
}

const pending = new Map<string, PendingVisitorLogin>();

function sweepExpired(now: number): void {
  for (const [state, entry] of pending) {
    if (entry.expiresAt <= now) pending.delete(state);
  }
}

function errorRedirect(appId: string, reason: string): string {
  return `/full/apps/${encodeURIComponent(appId)}?visitor=error&reason=${encodeURIComponent(reason)}`;
}

function dashboardErrorRedirect(reason: string): string {
  return `/login?visitor=error&reason=${encodeURIComponent(reason)}`;
}

function pendingErrorRedirect(entry: PendingVisitorLogin, reason: string): string {
  return entry.scope === "app"
    ? errorRedirect(entry.appId, reason)
    : dashboardErrorRedirect(reason);
}

function fallbackNext(appId: string): string {
  return `/full/apps/${encodeURIComponent(appId)}`;
}

function normalizeAppScopedNext(raw: unknown, appId: string): string {
  if (typeof raw !== "string" || !raw.startsWith("/") || raw.startsWith("//")) {
    return fallbackNext(appId);
  }

  try {
    const url = new URL(raw, "https://rome.local");
    const match = url.pathname.match(/^\/(?:full\/)?apps\/([^/]+)(?:\/|$)/);
    if (!match) return fallbackNext(appId);
    const routedAppId = decodeURIComponent(match[1]);
    if (routedAppId !== appId) return fallbackNext(appId);
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return fallbackNext(appId);
  }
}

function normalizeDashboardNext(raw: unknown): string {
  if (typeof raw !== "string" || !raw.startsWith("/") || raw.startsWith("//")) {
    return "/";
  }

  try {
    const url = new URL(raw, "https://rome.local");
    if (url.pathname.startsWith("/api/")) return "/";
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return "/";
  }
}

function exchangeBody(code: string, verifier: string): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, code_verifier: verifier }),
    signal: AbortSignal.timeout(30_000),
  };
}

// Mint PKCE + state, register the pending attempt, and return the Rome Cloud
// `/instance/authorize` URL for it. Returns null when no Rome Cloud origin is
// configured. The pending map is module-scoped, so an entry registered here is
// redeemable at `/auth/visitor/callback` no matter which route started it.
function beginVisitorFlow(entry: PendingVisitorLoginDraft): string | null {
  const origin = getRomeCloudOrigin();
  if (!origin) return null;

  const redirectUri = new URL(CALLBACK_PATH, getInstanceOrigin()).toString();
  const now = Date.now();
  sweepExpired(now);
  const pkce = createPkce();
  const state = randomBytes(16).toString("base64url");
  pending.set(state, {
    ...entry,
    verifier: pkce.verifier,
    expiresAt: now + PENDING_TTL_MS,
  });

  const authorizeUrl = new URL("/instance/authorize", origin);
  authorizeUrl.searchParams.set("redirect_uri", redirectUri);
  authorizeUrl.searchParams.set("code_challenge", pkce.challenge);
  authorizeUrl.searchParams.set("code_challenge_method", "S256");
  authorizeUrl.searchParams.set("state", state);
  authorizeUrl.searchParams.set("instance_name", hostname());
  authorizeUrl.searchParams.set("intent", "signin");
  return authorizeUrl.toString();
}

// Start a dashboard-scoped visitor attempt outside the POST route. Used by the
// cloud-login callback's not-owner dispatch: a Rome Cloud account that isn't
// the guardian gets re-routed here so an invited email still lands a visitor
// session from the single "Sign in with Rome Cloud" button. The caller gates
// on the dashboard allow-list; the visitor callback re-checks it regardless.
export function beginDashboardVisitorFlow(next?: string): string | null {
  return beginVisitorFlow({ scope: "dashboard", next: normalizeDashboardNext(next) });
}

export function visitorAuthRoutes(deps: ApiDeps, seams: VisitorAuthSeams = {}): Hono {
  const app = new Hono();
  const fetchImpl = seams.fetchImpl ?? globalThis.fetch;

  app.post("/auth/visitor/start", async (c) => {
    const body = await c.req
      .json<{ appId?: unknown; next?: unknown; scope?: unknown }>()
      .catch(() => null);
    const scope = body?.scope === "dashboard" ? "dashboard" : "app";

    let pendingEntry: PendingVisitorLoginDraft;
    if (scope === "dashboard") {
      if (!deps.dashboardAccessState.hasCloudEmailAccess()) {
        return c.json({ error: "dashboard_not_cloud_email_restricted" }, 404);
      }
      pendingEntry = {
        scope: "dashboard",
        next: normalizeDashboardNext(body?.next),
      };
    } else {
      const appId = typeof body?.appId === "string" ? body.appId.trim() : "";
      if (!isValidAppId(appId)) {
        return c.json({ error: "invalid_app_id" }, 400);
      }
      // Visitor sign-in is available on any publicly reachable app surface:
      // cloud-email apps need it to gate entry, and link-public apps need it
      // so features that require a verified Rome Cloud visitor — favor
      // request actions in particular — can establish a visitor
      // session. Without this, `ctx.favors.requestAction` on a public app
      // always fails with `visitor_auth_required` because no flow ever sets
      // the visitor cookie on the instance origin.
      if (
        !deps.publicAccessState.isCloudEmailApp(appId) &&
        !deps.publicAccessState.isPublicApp(appId)
      ) {
        return c.json({ error: "app_not_publicly_accessible" }, 404);
      }
      pendingEntry = {
        scope: "app",
        appId,
        next: normalizeAppScopedNext(body?.next, appId),
      };
    }

    const authorizeUrl = beginVisitorFlow(pendingEntry);
    if (!authorizeUrl) {
      return c.json({ error: "pantheon_origin_unconfigured" }, 503);
    }

    return c.json({ authorizeUrl });
  });

  // Visitor-only sign-out: clears the visitor cookie and nothing else. An app
  // surface must never be able to end the guardian's dashboard session — that
  // is `/auth/logout`, which clears both cookies and belongs to the dashboard.
  app.post("/auth/visitor/logout", (c) => {
    deleteCookie(c, VISITOR_COOKIE_NAME, {
      path: "/",
      secure: shouldSecureCookie(c.req.raw),
      sameSite: "Lax",
    });
    return c.json({ success: true });
  });

  app.get("/auth/visitor/callback", async (c) => {
    const state = c.req.query("state");
    const code = c.req.query("code");
    const oauthError = c.req.query("error");

    const entry = state ? pending.get(state) : undefined;
    if (!state || !entry) {
      return c.redirect("/?visitor=error&reason=state");
    }
    pending.delete(state);
    if (entry.expiresAt <= Date.now()) {
      return c.redirect(pendingErrorRedirect(entry, "expired"));
    }
    if (oauthError || !code) {
      return c.redirect(pendingErrorRedirect(entry, "denied"));
    }

    const origin = getRomeCloudOrigin();
    if (!origin) {
      return c.redirect(pendingErrorRedirect(entry, "unconfigured"));
    }

    try {
      const response = await fetchImpl(
        new URL("/api/account/session", origin),
        exchangeBody(code, entry.verifier),
      );
      if (!response.ok) {
        log.warn("visitor account session exchange failed", { status: response.status });
        return c.redirect(pendingErrorRedirect(entry, "exchange"));
      }

      const data = (await response.json().catch(() => null)) as AccountSessionResponse | null;
      const accountId = typeof data?.accountId === "string" ? data.accountId : null;
      const email = normalizePublicAccessEmail(data?.email);
      const favorViewerToken =
        typeof data?.favorViewerToken === "string" && data.favorViewerToken.trim()
          ? data.favorViewerToken
          : null;
      const avatarUrl =
        typeof data?.avatarUrl === "string" && data.avatarUrl.trim() ? data.avatarUrl.trim() : null;
      if (!accountId || !email || !favorViewerToken) {
        return c.redirect(pendingErrorRedirect(entry, "malformed"));
      }

      if (entry.scope === "dashboard" && !deps.dashboardAccessState.isCloudEmailAllowed(email)) {
        // The fragment keeps the rejected email out of request URLs and referrers.
        c.header("Cache-Control", "no-store");
        return c.redirect(
          `${dashboardErrorRedirect("forbidden")}#email=${encodeURIComponent(email)}`,
        );
      }

      issueVisitorSession(c, accountId, email, favorViewerToken, avatarUrl);
      return c.redirect(entry.next);
    } catch (err) {
      log.warn("visitor login errored", {
        error: err instanceof Error ? err.message : String(err),
      });
      return c.redirect(pendingErrorRedirect(entry, "network"));
    }
  });

  return app;
}
