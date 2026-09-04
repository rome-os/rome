import { randomBytes } from "node:crypto";
import { hostname } from "node:os";
import { verifyIdToken } from "@rome-os/libs/oidc";
import { createPkce } from "@rome-os/libs/pkce";
import { Hono, type Context } from "hono";
import { COOKIE_NAME, createGuardianSession, issueGuardianSession } from "../../lib/auth.js";
import {
  createCloudGuardian,
  getGuardianAuthState,
  setGuardianAccount,
} from "../../lib/guardian-auth-state.js";
import { applySetupDefaults, defaultGuardianName } from "../../lib/guardian-profile.js";
import {
  getInstanceToken,
  isValidInstanceToken,
  persistInstanceToken,
} from "../../lib/instance-identity.js";
import { getInstanceOrigin, getRomeCloudOrigin } from "../../lib/rome-cloud-origin.js";
import { createLogger } from "../../logger.js";
import type { ApiDeps } from "../deps.js";
import { beginDashboardVisitorFlow } from "./visitor-auth.js";

const log = createLogger("api:cloud-login");

// Cloud guardian sign-in via the standard OAuth surface: one
// `/oauth2/authorize` → `/oauth2/token` round trip, with the identity
// assertion an asymmetrically-signed `id_token` verified via JWKS. The
// browser leg authenticates a *guardian* against their Rome Cloud account.
// One callback covers both instance states:
//
//   - Vanilla (no instance token): request scope `openid instance:enroll`. The
//     token leg returns the `id_token` AND mints the durable instance token, so a
//     single code enrolls the instance and identifies the guardian in one shot.
//   - Bound (instance token present): request scope `openid`. The token leg
//     returns just the `id_token`.
//
// Ownership is enforced *server-side at `/authorize`* — Rome Cloud only ever
// issues a code to the account that owns this instance — so a verified
// `id_token`'s `sub` IS the confirmed owner. A token that fails verification
// (bad signature, wrong `iss`/`aud`, nonce mismatch, expiry) fails the
// sign-in closed; the local password fallback covers a Rome Cloud outage, so
// the owner is never locked out of their own box.

const CALLBACK_PATH = "/api/auth/cloud/callback";
const PENDING_TTL_MS = 10 * 60_000;
// Must match Rome Cloud's OAUTH_CLIENT_ID. The single OAuth client is "a Rome
// instance" — every instance runs the same core — so this is a fixed
// constant, not a per-instance value; it becomes the `id_token` audience.
const OAUTH_CLIENT_ID = "rome-instance";

// Every callback outcome redirects to one of these constant internal paths —
// never anything derived from the request — so the callback can't be turned into
// an open redirector. Success bounces to the dashboard root (a hard navigation so
// the SPA re-bootstraps with the new session). A sign-in that creates the seat
// lands on the welcome conversation instead: setup is already complete, so the
// welcome app is the first screen. Failures return to /login, the cloud-default
// sign-in entry: whatever the instance state, the retry affordance and the error
// banner live there.
const SUCCESS_PATH = "/";
const LOGIN_PATH = "/login";
const WELCOME_PATH = "/full/apps/welcome-to-rome";

interface PendingLogin {
  channel: "browser" | "native";
  verifier: string;
  nonce: string;
  redirectUri: string;
  expiresAt: number;
}

// state nonce -> pending attempt. In-process and short-lived: the flow completes
// in one browser round-trip, and a stale entry is swept on the next access.
const pending = new Map<string, PendingLogin>();

function createPendingLogin(
  channel: PendingLogin["channel"],
  redirectUri: string,
  now = Date.now(),
): { state: string; nonce: string; challenge: string; expiresAt: number } {
  sweepExpired(now);
  const pkce = createPkce();
  const state = randomBytes(16).toString("base64url");
  const nonce = randomBytes(16).toString("base64url");
  const expiresAt = now + PENDING_TTL_MS;
  pending.set(state, {
    channel,
    verifier: pkce.verifier,
    nonce,
    redirectUri,
    expiresAt,
  });
  return { state, nonce, challenge: pkce.challenge, expiresAt };
}

function sweepExpired(now: number): void {
  for (const [state, entry] of pending) {
    if (entry.expiresAt <= now) pending.delete(state);
  }
}

function successRedirect(): string {
  return `${SUCCESS_PATH}?cloud=success`;
}

// Errors land back on /login, the cloud-default sign-in entry, regardless of
// instance state — that page carries the retry button and renders the reason.
function errorRedirect(reason: string): string {
  return `${LOGIN_PATH}?cloud=error&reason=${reason}`;
}

interface TokenResponse {
  id_token?: unknown;
  instance_token?: unknown;
  instance_id?: unknown;
}

// Test seam: the only network the flow touches is Rome Cloud's `/oauth2/token`
// exchange and the `/oauth2/jwks` fetch inside `verifyIdToken`. Injecting one
// `fetch` lets the route be driven end-to-end over HTTP without a live Rome Cloud.
// Production passes nothing and gets the real global.
export interface CloudLoginSeams {
  fetchImpl?: typeof fetch;
}

export function cloudLoginRoutes(deps: ApiDeps, seams: CloudLoginSeams = {}): Hono {
  const app = new Hono();
  const fetchImpl = seams.fetchImpl ?? globalThis.fetch;

  // The scope encodes intent: a box with no instance token is binding for the
  // first time (`instance:enroll` mints its token at the token leg); one
  // that already holds a token is just signing a user in (`openid`).
  app.post("/auth/cloud/start", async (c) => {
    if (!(await deps.isCloudAuthEnabled())) {
      return c.json({ error: "cloud_auth_disabled" }, 404);
    }

    const origin = getRomeCloudOrigin();
    if (!origin) {
      return c.json({ error: "pantheon_origin_unconfigured" }, 503);
    }

    // The instance states its own address for the callback rather than inferring
    // it from the request (see getInstanceOrigin / instance-enroll for the
    // forwarded-host reasoning these flows share).
    const redirectUri = new URL(CALLBACK_PATH, getInstanceOrigin()).toString();

    const attempt = createPendingLogin("browser", redirectUri);

    const scope = getInstanceToken() === null ? "openid instance:enroll" : "openid";

    const authorizeUrl = new URL("/oauth2/authorize", origin);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("client_id", OAUTH_CLIENT_ID);
    authorizeUrl.searchParams.set("redirect_uri", redirectUri);
    authorizeUrl.searchParams.set("scope", scope);
    authorizeUrl.searchParams.set("state", attempt.state);
    authorizeUrl.searchParams.set("code_challenge", attempt.challenge);
    authorizeUrl.searchParams.set("code_challenge_method", "S256");
    authorizeUrl.searchParams.set("nonce", attempt.nonce);
    authorizeUrl.searchParams.set("instance_name", hostname());

    return c.json({ authorizeUrl: authorizeUrl.toString() });
  });

  // Native does not open the instance callback in a WebView. It asks Core for
  // the same PKCE-bound request, has Rome Cloud mint a code for an owned hosted
  // instance, then returns that code to `/native/complete`.
  app.post("/auth/cloud/native/start", async (c) => {
    c.header("Cache-Control", "no-store");
    if (!(await deps.isCloudAuthEnabled())) {
      return c.json({ error: "cloud_auth_disabled" }, 404);
    }
    if (!isValidInstanceToken(getInstanceToken())) {
      return c.json({ error: "instance_not_enrolled" }, 409);
    }
    if (!getRomeCloudOrigin()) {
      return c.json({ error: "pantheon_origin_unconfigured" }, 503);
    }

    const instanceOrigin = getInstanceOrigin();
    const redirectUri = new URL(CALLBACK_PATH, instanceOrigin).toString();
    const attempt = createPendingLogin("native", redirectUri);

    return c.json({
      authorization_request: {
        response_type: "code",
        client_id: OAUTH_CLIENT_ID,
        redirect_uri: redirectUri,
        scope: "openid",
        state: attempt.state,
        code_challenge: attempt.challenge,
        code_challenge_method: "S256",
        nonce: attempt.nonce,
      },
      origin: instanceOrigin,
      expires_at: new Date(attempt.expiresAt).toISOString(),
    });
  });

  app.post("/auth/cloud/native/complete", async (c) => {
    c.header("Cache-Control", "no-store");
    if (!(await deps.isCloudAuthEnabled())) {
      return c.json({ error: "cloud_auth_disabled" }, 404);
    }

    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    const state = typeof body?.state === "string" ? body.state : null;
    const code = typeof body?.code === "string" ? body.code : null;
    const presentedIssuer = typeof body?.iss === "string" ? body.iss : null;
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

    const issuer = getRomeCloudOrigin();
    if (!issuer) {
      return c.json({ error: "cloud_unavailable" }, 503);
    }
    if (presentedIssuer !== issuer) {
      return c.json({ error: "unverified_identity" }, 401);
    }

    try {
      const exchange = await exchangeToken({
        origin: issuer,
        code,
        verifier: entry.verifier,
        redirectUri: entry.redirectUri,
      });
      if (!exchange.ok) {
        return exchange.status >= 400 && exchange.status < 500
          ? c.json({ error: "invalid_grant" }, 400)
          : c.json({ error: "cloud_unavailable" }, 503);
      }
      const identity = await verifyCloudIdentity(exchange.tokens, issuer, entry);
      if (!identity) {
        return c.json({ error: "unverified_identity" }, 401);
      }

      const guardian = await getGuardianAuthState(deps.db);
      if (guardian.exists) {
        await setGuardianAccount(deps.db, identity.accountId, identity.email, identity.avatarUrl);
      } else {
        await createGuardianSeat(identity);
      }

      const session = createGuardianSession(identity.accountId);
      return c.json({
        cookie_name: COOKIE_NAME,
        session_token: session.token,
        expires_at: session.expiresAt,
        origin: getInstanceOrigin(),
      });
    } catch (err) {
      log.warn("native cloud login errored", {
        error: err instanceof Error ? err.message : String(err),
      });
      return c.json({ error: "cloud_unavailable" }, 503);
    }
  });

  // Every outcome redirects to a constant path with a `cloud` marker; only
  // success sets the session cookie.
  app.get("/auth/cloud/callback", async (c) => {
    if (!(await deps.isCloudAuthEnabled())) {
      return c.json({ error: "cloud_auth_disabled" }, 404);
    }

    // Whether this is a vanilla (enroll-and-bind) or bound (sign-in) round trip
    // depends on local state and decides whether we expect an instance token back.
    const vanilla = getInstanceToken() === null;

    const state = c.req.query("state");
    const code = c.req.query("code");
    const oauthError = c.req.query("error");

    // Fail closed on the state echo before trusting anything else.
    const entry = state ? pending.get(state) : undefined;
    if (!state || !entry || entry.channel !== "browser") {
      return c.redirect(errorRedirect("state"));
    }
    pending.delete(state);
    if (entry.expiresAt <= Date.now()) {
      return c.redirect(errorRedirect("expired"));
    }
    if (oauthError || !code) {
      // `access_denied` is Rome Cloud's not-owner refusal: the human proved a
      // Rome Cloud identity, it just isn't the account that owns this box.
      // The login UI has a single "Sign in with Rome Cloud" button, so this
      // callback owns the fork: when the guardian has invited emails to the
      // dashboard, re-route the browser into the visitor attestation flow
      // (they already hold a Rome Cloud session — one redirect hop, no second
      // credential entry, and the visitor callback still enforces the
      // allow-list). With no allow-list there is nothing to dispatch to.
      // The error redirect carries `iss` like every authorize response
      // (RFC 9207); validate it before acting on the error, same as below.
      if (oauthError === "access_denied") {
        const issuer = getRomeCloudOrigin();
        const issParam = c.req.query("iss");
        if (!issuer || issParam !== issuer) {
          log.warn("access_denied redirect with missing/mismatched iss", {
            expected: issuer,
            got: issParam ?? null,
          });
          return c.redirect(errorRedirect("iss"));
        }
        if (deps.dashboardAccessState.hasCloudEmailAccess()) {
          const authorizeUrl = beginDashboardVisitorFlow();
          if (authorizeUrl) {
            log.info("cloud login not-owner; dispatching to dashboard visitor flow");
            return c.redirect(authorizeUrl);
          }
        }
        return c.redirect(errorRedirect("not_owner"));
      }
      return c.redirect(errorRedirect("denied"));
    }

    // The `id_token` issuer is Rome Cloud's origin — the same origin we fetch JWKS
    // from and validate the redirect's `iss` against. Must be known.
    const issuer = getRomeCloudOrigin();
    if (!issuer) {
      return c.redirect(errorRedirect("unconfigured"));
    }

    // RFC 9207 mix-up protection: Rome Cloud always appends `iss` to the redirect,
    // so a missing one is as suspicious as a wrong one — both fail closed. The
    // id_token's own `iss` is still validated below; this is the redirect-layer
    // guard RFC 9207 exists for.
    const issParam = c.req.query("iss");
    if (!issParam || issParam !== issuer) {
      log.warn("cloud login iss missing or mismatch", { expected: issuer, got: issParam ?? null });
      return c.redirect(errorRedirect("iss"));
    }

    try {
      const exchange = await exchangeToken({
        origin: issuer,
        code,
        verifier: entry.verifier,
        redirectUri: entry.redirectUri,
      });
      if (!exchange.ok || typeof exchange.tokens.id_token !== "string") {
        log.warn("token exchange failed or returned no id_token");
        return c.redirect(errorRedirect("exchange"));
      }
      const tokens = exchange.tokens;

      const identity = await verifyCloudIdentity(tokens, issuer, entry);
      if (!identity) {
        return c.redirect(errorRedirect("unverified"));
      }
      const { accountId, email: accountEmail, avatarUrl: accountAvatarUrl } = identity;

      // Vanilla: the token leg also minted the durable instance token. Persist it
      // before issuing the session so an enrolled box never lacks its credential.
      if (vanilla) {
        const instanceToken = tokens.instance_token;
        if (!isValidInstanceToken(typeof instanceToken === "string" ? instanceToken : null)) {
          return c.redirect(errorRedirect("malformed"));
        }
        await persistInstanceToken(deps.settingsRepo, instanceToken as string);
        log.info("cloud login enrolled instance", { accountId });
      }

      // Ownership was confirmed server-side at /authorize, so `sub` is the owner.
      // Stamp it as the explicit-login binding (repairing a null/stale recorded
      // owner); on an existing username/password instance this IS the implicit
      // link — the accountId lands on the guardian row, the local password stays.
      await setGuardianAccount(deps.db, accountId, accountEmail, accountAvatarUrl);
      return await finishSignedIn(c, identity);
    } catch (err) {
      // A network throw at any leg is non-terminal: offer retry/local fallback.
      log.warn("cloud login errored", {
        error: err instanceof Error ? err.message : String(err),
      });
      return c.redirect(errorRedirect("network"));
    }
  });

  interface ExchangeArgs {
    origin: string;
    code: string;
    verifier: string;
    redirectUri: string;
  }

  type TokenExchangeResult = { ok: true; tokens: TokenResponse } | { ok: false; status: number };

  // Back-channel token exchange. Form-encoded per OAuth; returns the
  // parsed JSON body, or null on a non-2xx / unparseable response.
  async function exchangeToken(args: ExchangeArgs): Promise<TokenExchangeResult> {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code: args.code,
      code_verifier: args.verifier,
      client_id: OAUTH_CLIENT_ID,
      redirect_uri: args.redirectUri,
    });
    const response = await fetchImpl(new URL("/oauth2/token", args.origin), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      log.warn("oauth token exchange failed", { status: response.status });
      return { ok: false, status: response.status };
    }
    const tokens = (await response.json().catch(() => null)) as TokenResponse | null;
    return tokens ? { ok: true, tokens } : { ok: false, status: 502 };
  }

  interface CloudIdentity {
    accountId: string;
    email?: string;
    avatarUrl?: string;
    /** The `name` claim, when Rome Cloud sends one. */
    name?: string;
  }

  async function verifyCloudIdentity(
    tokens: TokenResponse,
    issuer: string,
    entry: PendingLogin,
  ): Promise<CloudIdentity | null> {
    if (typeof tokens.id_token !== "string") return null;
    try {
      const verified = await verifyIdToken(tokens.id_token, {
        issuer,
        audience: OAUTH_CLIENT_ID,
        nonce: entry.nonce,
        jwksUri: new URL("/oauth2/jwks", issuer).toString(),
        fetch: fetchImpl,
      });
      const name = verified.payload.name;
      return {
        accountId: verified.sub,
        email: verified.email,
        avatarUrl: verified.picture,
        name: typeof name === "string" && name.trim() ? name.trim() : undefined,
      };
    } catch (err) {
      log.warn("id_token verification failed; failing closed", {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  // On a fresh instance the cloud round trip is the sole account source, so
  // the guardian seat is created from the consenting cloud account, and setup
  // finishes right here with defaults: the display name from the identity
  // assertion and a preset agent identity. The welcome conversation confirms
  // both, so the onboarding page is never shown on this path.
  async function createGuardianSeat(identity: CloudIdentity): Promise<void> {
    await createCloudGuardian(deps.db, identity.accountId, identity.email, identity.avatarUrl);
    await applySetupDefaults(defaultGuardianName(identity), {
      db: deps.db,
      settingsRepo: deps.settingsRepo,
      reactivateFloating: () => deps.routineEngine.reactivateFloating(),
    });
  }

  // The row is created BEFORE the cookie so a session never outruns a backing
  // guardian. A guardian that already exists is simply signed in.
  async function finishSignedIn(c: Context, identity: CloudIdentity) {
    const guardian = await getGuardianAuthState(deps.db);
    if (!guardian.exists) {
      await createGuardianSeat(identity);
      issueGuardianSession(c, identity.accountId);
      log.info("cloud login created the guardian seat and signed in", {
        accountId: identity.accountId,
      });
      return c.redirect(WELCOME_PATH);
    }
    issueGuardianSession(c, identity.accountId);
    log.info("cloud login signed in", { accountId: identity.accountId });
    return c.redirect(successRedirect());
  }

  return app;
}
