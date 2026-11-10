import { randomBytes } from "node:crypto";
import { createPkce } from "@rome-os/libs/pkce";
import { hostname } from "node:os";
import { deleteCookie } from "hono/cookie";
import { Hono, type Context } from "hono";
import {
  VISITOR_COOKIE_NAME,
  createVisitorSessionEnvelope,
  issueVisitorSession,
  shouldSecureCookie,
} from "../../access/auth.js";
import { normalizeVisitorEmail } from "../../access/visitor-email.js";
import { isValidAppId } from "../../apps/packaging/app-id.js";
import { getInstanceOrigin, getRomeCloudOrigin } from "../../instance/rome-cloud-origin.js";
import { createLogger } from "../../logger.js";
import { VisitorProfilesRepository } from "../../access/visitor-profiles.js";
import type { ApiDeps } from "../deps.js";

const log = createLogger("api:visitor-auth");

const CALLBACK_PATH = "/api/auth/visitor/callback";
const PENDING_TTL_MS = 10 * 60_000;

// A browser attempt finishes at the callback, which sets the cookie. A native
// attempt finishes at `/auth/visitor/native/complete`, which returns the session
// as JSON. Neither can be redeemed at the other's endpoint.
type VisitorChannel = "browser" | "native";

type PendingVisitorLogin = PendingVisitorLoginDraft & {
  channel: VisitorChannel;
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

interface VisitorAuthorizationRequest {
  redirect_uri: string;
  code_challenge: string;
  code_challenge_method: "S256";
  state: string;
  instance_name: string;
  intent: "signin";
}

// Mint PKCE + state, register the pending attempt, and return the parameters
// of the Rome Cloud `/instance/authorize` request for it. Returns null when no
// Rome Cloud origin is configured. The pending map is module-scoped, so an
// entry registered here is redeemable on its channel no matter which route
// started it.
function registerVisitorAttempt(
  entry: PendingVisitorLoginDraft,
  channel: VisitorChannel,
): { request: VisitorAuthorizationRequest; origin: string; expiresAt: number } | null {
  const origin = getRomeCloudOrigin();
  if (!origin) return null;

  const now = Date.now();
  sweepExpired(now);
  const pkce = createPkce();
  const state = randomBytes(16).toString("base64url");
  const expiresAt = now + PENDING_TTL_MS;
  pending.set(state, { ...entry, channel, verifier: pkce.verifier, expiresAt });

  return {
    origin,
    expiresAt,
    request: {
      redirect_uri: new URL(CALLBACK_PATH, getInstanceOrigin()).toString(),
      code_challenge: pkce.challenge,
      code_challenge_method: "S256",
      state,
      instance_name: hostname(),
      intent: "signin",
    },
  };
}

// The browser attempt's Rome Cloud `/instance/authorize` URL, or null when no
// Rome Cloud origin is configured.
function beginVisitorFlow(entry: PendingVisitorLoginDraft): string | null {
  const attempt = registerVisitorAttempt(entry, "browser");
  if (!attempt) return null;
  const authorizeUrl = new URL("/instance/authorize", attempt.origin);
  for (const [key, value] of Object.entries(attempt.request)) {
    authorizeUrl.searchParams.set(key, value);
  }
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
  const visitorProfiles = new VisitorProfilesRepository(deps.db);

  type Redeemed =
    | {
        ok: true;
        accountId: string;
        email: string;
        avatarUrl: string | null;
        favorViewerToken: string;
      }
    | { ok: false; reason: "exchange"; status: number }
    | { ok: false; reason: "malformed" }
    | { ok: false; reason: "forbidden"; email: string };

  // Both channels redeem a code here: the Rome Cloud exchange, the checks on
  // what it returns, the dashboard allow-list re-check, and the profile write.
  // Only how the session reaches the caller differs. A network throw propagates.
  async function redeemVisitorCode(
    origin: string,
    code: string,
    entry: PendingVisitorLogin,
  ): Promise<Redeemed> {
    const response = await fetchImpl(
      new URL("/api/account/session", origin),
      exchangeBody(code, entry.verifier),
    );
    if (!response.ok) {
      log.warn("visitor account session exchange failed", { status: response.status });
      return { ok: false, reason: "exchange", status: response.status };
    }

    const data = (await response.json().catch(() => null)) as AccountSessionResponse | null;
    const accountId = typeof data?.accountId === "string" ? data.accountId : null;
    const email = normalizeVisitorEmail(data?.email);
    const favorViewerToken =
      typeof data?.favorViewerToken === "string" && data.favorViewerToken.trim()
        ? data.favorViewerToken
        : null;
    const avatarUrl =
      typeof data?.avatarUrl === "string" && data.avatarUrl.trim() ? data.avatarUrl.trim() : null;
    if (!accountId || !email || !favorViewerToken) {
      return { ok: false, reason: "malformed" };
    }

    if (entry.scope === "dashboard" && !deps.dashboardAccessState.isCloudEmailAllowed(email)) {
      return { ok: false, reason: "forbidden", email };
    }

    // Any visitor may also be on the dashboard list, so every sign-in keeps
    // the profile. Chat shows it beside their messages, and a failed write
    // costs only that, so it never fails the sign-in.
    await visitorProfiles.record(accountId, { email, avatarUrl }).catch((err: unknown) => {
      log.warn("visitor profile write failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    });
    // A listed email signing in with an account it has not used here may come
    // from an account made after the last sync, or made again after a delete,
    // which Rome Cloud could not match then. Resend the list once so it can
    // list this instance to that account. A failed record costs only that.
    const newAccount = await deps.dashboardAccessStore
      .recordVisitorSignIn(email, accountId)
      .catch((err: unknown) => {
        log.warn("visitor sign-in record failed", {
          error: err instanceof Error ? err.message : String(err),
        });
        return false;
      });
    if (newAccount) deps.visitorAllowListSync.requestResend();
    return { ok: true, accountId, email, avatarUrl, favorViewerToken };
  }

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
      const permission = deps.permissions.get(appId);
      if (!permission.anyoneWithLink && permission.listedEmails.size === 0) {
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
    if (!state || !entry || entry.channel !== "browser") {
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
      const redeemed = await redeemVisitorCode(origin, code, entry);
      if (!redeemed.ok) {
        if (redeemed.reason === "forbidden") {
          // The fragment keeps the rejected email out of request URLs and referrers.
          c.header("Cache-Control", "no-store");
          return c.redirect(
            `${dashboardErrorRedirect("forbidden")}#email=${encodeURIComponent(redeemed.email)}`,
          );
        }
        return c.redirect(pendingErrorRedirect(entry, redeemed.reason));
      }
      issueVisitorSession(
        c,
        redeemed.accountId,
        redeemed.email,
        redeemed.favorViewerToken,
        redeemed.avatarUrl,
      );
      return c.redirect(entry.next);
    } catch (err) {
      log.warn("visitor login errored", {
        error: err instanceof Error ? err.message : String(err),
      });
      return c.redirect(pendingErrorRedirect(entry, "network"));
    }
  });

  // The phone's dashboard visitor sign-in. It asks for the same PKCE-bound
  // request the browser flow sends to Rome Cloud, has Rome Cloud issue the code
  // for it, and brings the code back to `/auth/visitor/native/complete`.
  app.post("/auth/visitor/native/start", (c) => {
    c.header("Cache-Control", "no-store");
    if (!deps.dashboardAccessState.hasCloudEmailAccess()) {
      return c.json({ error: "dashboard_not_cloud_email_restricted" }, 404);
    }
    const attempt = registerVisitorAttempt({ scope: "dashboard", next: "/" }, "native");
    if (!attempt) {
      return c.json({ error: "pantheon_origin_unconfigured" }, 503);
    }
    return c.json({
      visitor_authorization_request: attempt.request,
      origin: getInstanceOrigin(),
      expires_at: new Date(attempt.expiresAt).toISOString(),
    });
  });

  // Redeems the phone's code like the callback does, and returns the visitor
  // session as JSON instead of setting the cookie.
  app.post("/auth/visitor/native/complete", async (c) => {
    c.header("Cache-Control", "no-store");
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    const state = typeof body?.state === "string" ? body.state : null;
    const code = typeof body?.code === "string" ? body.code : null;
    const entry = state ? pending.get(state) : undefined;
    if (!state || !entry || entry.channel !== "native") {
      return c.json({ error: "invalid_state" }, 400);
    }
    pending.delete(state);
    if (entry.expiresAt <= Date.now()) {
      return c.json({ error: "invalid_state" }, 400);
    }
    if (!code) {
      return c.json({ error: "invalid_grant" }, 400);
    }
    const origin = getRomeCloudOrigin();
    if (!origin) {
      return c.json({ error: "cloud_unavailable" }, 503);
    }

    try {
      const redeemed = await redeemVisitorCode(origin, code, entry);
      if (!redeemed.ok) {
        switch (redeemed.reason) {
          case "forbidden":
            log.info("native visitor sign-in refused: not on the dashboard allow-list");
            return c.json({ error: "not_allowed" }, 403);
          case "malformed":
            return c.json({ error: "cloud_unavailable" }, 502);
          case "exchange":
            return redeemed.status >= 400 && redeemed.status < 500
              ? c.json({ error: "invalid_grant" }, 400)
              : c.json({ error: "cloud_unavailable" }, 503);
        }
      }
      const session = createVisitorSessionEnvelope(
        redeemed.accountId,
        redeemed.email,
        redeemed.favorViewerToken,
        redeemed.avatarUrl,
      );
      log.info("native visitor signed in", { accountId: redeemed.accountId });
      return c.json({
        cookie_name: VISITOR_COOKIE_NAME,
        session_token: session.token,
        expires_at: session.expiresAt,
        origin: getInstanceOrigin(),
        role: "visitor",
      });
    } catch (err) {
      log.warn("native visitor login errored", {
        error: err instanceof Error ? err.message : String(err),
      });
      return c.json({ error: "cloud_unavailable" }, 503);
    }
  });

  return app;
}
