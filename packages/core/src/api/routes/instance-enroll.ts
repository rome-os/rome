import { randomBytes } from "node:crypto";
import { createPkce } from "@rome-os/libs/pkce";
import { hostname } from "node:os";
import { Hono } from "hono";
import {
  clearInstanceToken,
  getInstanceToken,
  persistInstanceToken,
  proveIdentity,
  type ProveIdentityResult,
} from "../../lib/instance-identity.js";
import { ensureRelayMailbox } from "../../lib/rome-cloud-relay.js";
import { getInstanceOrigin, getRomeCloudOrigin } from "../../lib/rome-cloud-origin.js";
import { RELAY_SETTING_KEY } from "../../relay/settings.js";
import { createLogger } from "../../logger.js";
import type { ApiDeps } from "../deps.js";

const log = createLogger("api:instance-enroll");

// The in-app port of the self-enroll flow. The durable instance token is
// minted by Rome Cloud through a PKCE + loopback OAuth exchange, landing in
// core's own DB — the single runtime read path — rather than a Keychain, so
// one flow covers both desktop and local.
//
// Loopback is preserved exactly: `redirect_uri` is core's own callback on the
// loopback origin the browser is already using, so Rome Cloud's loopback-only
// validation accepts it unchanged. The plaintext token crosses this process
// once, straight into the settings store.

const CALLBACK_PATH = "/api/instance/enroll/callback";
const PENDING_TTL_MS = 10 * 60_000;
const INSTANCE_CHECK_TIMEOUT_MS = 5_000;
// The callback only ever redirects to one of these two constant internal paths —
// never anything derived from the request — so it can't be turned into an open
// redirector. Success bounces to the dashboard root (a hard navigation, so the
// SPA re-bootstraps and sees the instance as enrolled); failure returns to the
// connect page carrying a reason for display.
const SUCCESS_PATH = "/";
const CONNECT_PATH = "/connect";

interface PendingEnroll {
  verifier: string;
  expiresAt: number;
}

// state nonce -> PKCE verifier. In-process and short-lived: the flow completes
// in one browser round-trip, and a stale entry is swept on the next access.
const pending = new Map<string, PendingEnroll>();

function sweepExpired(now: number): void {
  for (const [state, entry] of pending) {
    if (entry.expiresAt <= now) pending.delete(state);
  }
}

function enrolledRedirect(): string {
  return `${SUCCESS_PATH}?enroll=success`;
}

function errorRedirect(reason: string): string {
  return `${CONNECT_PATH}?enroll=error&reason=${reason}`;
}

interface TokenResponse {
  instanceToken?: unknown;
  instanceId?: unknown;
}

export interface InstanceEnrollSeams {
  proveIdentity?: typeof proveIdentity;
  ensureRelayMailbox?: typeof ensureRelayMailbox;
  fetchImpl?: typeof fetch;
}

type EnrollStartGate = { ok: true } | { ok: false; status: 409 | 503; error: string };

async function clearRejectedInstanceState(deps: ApiDeps, reason: "revoked" | "unknown") {
  await clearInstanceToken(deps.settingsRepo);
  await deps.settingsRepo.delete(RELAY_SETTING_KEY);
  try {
    await deps.relayDrainer.reload([]);
  } catch (err) {
    log.warn("failed to stop relay drainer after clearing rejected instance token", {
      reason,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  log.warn("cleared rejected instance token before reconnect enrollment", { reason });
}

async function checkExistingEnrollment(
  deps: ApiDeps,
  seams: InstanceEnrollSeams,
): Promise<EnrollStartGate> {
  if (!getInstanceToken()) return { ok: true };

  let auth: ProveIdentityResult;
  try {
    auth = await (seams.proveIdentity ?? proveIdentity)({
      fetch: (input, init) =>
        fetch(input, { ...init, signal: AbortSignal.timeout(INSTANCE_CHECK_TIMEOUT_MS) }),
    });
  } catch (err) {
    log.warn("instance identity check before enrollment failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, status: 503, error: "identity_unreachable" };
  }

  switch (auth.status) {
    case "ok":
      return { ok: false, status: 409, error: "already_enrolled" };
    case "revoked":
    case "unknown":
      await clearRejectedInstanceState(deps, auth.status);
      return { ok: true };
    case "no_token":
      return { ok: true };
    case "unconfigured":
      return { ok: false, status: 503, error: "pantheon_origin_unconfigured" };
    case "unreachable":
      return { ok: false, status: 503, error: "identity_unreachable" };
  }
}

export function instanceEnrollRoutes(deps: ApiDeps, seams: InstanceEnrollSeams = {}): Hono {
  const app = new Hono();
  const fetchImpl = seams.fetchImpl ?? globalThis.fetch;

  // The verifier never leaves this process; only the challenge rides the
  // browser leg.
  app.post("/instance/enroll/start", async (c) => {
    const enrollment = await checkExistingEnrollment(deps, seams);
    if (!enrollment.ok) {
      return c.json({ error: enrollment.error }, enrollment.status);
    }

    const origin = getRomeCloudOrigin();
    if (!origin) {
      return c.json({ error: "pantheon_origin_unconfigured" }, 503);
    }

    // Where Rome Cloud sends the browser back with the auth code. The instance
    // states its OWN address (getInstanceOrigin) rather than inferring it
    // from the request's x-forwarded-host: a proxy chain (Cloudflare → Traefik →
    // rsbuild) can rewrite that header to an internal host, so trusting it lands
    // the callback where the browser can't reach it. Behind a proxy the origin
    // must be configured (PANTHEON_INSTANCE_ORIGIN, or PANTHEON_SLUG + PANTHEON_DOMAIN);
    // desktop/local fall through to the loopback address core serves on, which
    // Rome Cloud's redirect gate accepts.
    const redirectUri = new URL(CALLBACK_PATH, getInstanceOrigin()).toString();

    const now = Date.now();
    sweepExpired(now);
    const pkce = createPkce();
    const state = randomBytes(16).toString("base64url");
    pending.set(state, { verifier: pkce.verifier, expiresAt: now + PENDING_TTL_MS });

    const authorizeUrl = new URL("/instance/authorize", origin);
    authorizeUrl.searchParams.set("redirect_uri", redirectUri);
    authorizeUrl.searchParams.set("code_challenge", pkce.challenge);
    authorizeUrl.searchParams.set("code_challenge_method", "S256");
    authorizeUrl.searchParams.set("state", state);
    authorizeUrl.searchParams.set("instance_name", hostname());
    // This flow only ever binds a new instance, so the consent screen and the
    // token leg both see the register intent.
    authorizeUrl.searchParams.set("intent", "register");

    return c.json({ authorizeUrl: authorizeUrl.toString() });
  });

  // Every outcome redirects to the same constant path with an `enroll` marker.
  app.get("/instance/enroll/callback", async (c) => {
    const state = c.req.query("state");
    const code = c.req.query("code");
    const oauthError = c.req.query("error");

    // Fail closed on the state echo before trusting anything else.
    const entry = state ? pending.get(state) : undefined;
    if (!state || !entry) {
      return c.redirect(errorRedirect("state"));
    }
    pending.delete(state);
    if (entry.expiresAt <= Date.now()) {
      return c.redirect(errorRedirect("expired"));
    }
    if (oauthError || !code) {
      return c.redirect(errorRedirect("denied"));
    }

    const origin = getRomeCloudOrigin();
    if (!origin) {
      return c.redirect(errorRedirect("unconfigured"));
    }

    try {
      const response = await fetchImpl(new URL("/api/instance/token", origin), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code, code_verifier: entry.verifier }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) {
        const reason = (await response.json().catch(() => null)) as { error?: unknown } | null;
        const detail = typeof reason?.error === "string" ? reason.error : `http_${response.status}`;
        log.warn("token exchange failed", { detail });
        return c.redirect(errorRedirect("exchange"));
      }

      const data = (await response.json().catch(() => null)) as TokenResponse | null;
      const token = typeof data?.instanceToken === "string" ? data.instanceToken : null;
      const instanceId = typeof data?.instanceId === "string" ? data.instanceId : null;
      if (!token || !instanceId) {
        return c.redirect(errorRedirect("malformed"));
      }

      await persistInstanceToken(deps.settingsRepo, token);
      void deps.provisionNodeCaller?.();
      log.info("instance enrolled via in-app OAuth", { instanceId });
      void (seams.ensureRelayMailbox ?? ensureRelayMailbox)({
        settingsRepo: deps.settingsRepo,
        appCatalog: deps.appCatalog,
        relayDrainer: deps.relayDrainer,
      })
        .then((result) => {
          switch (result.status) {
            case "provisioned":
              log.info("relay mailbox provisioned after instance enrollment", {
                mailboxId: result.mailboxId,
              });
              break;
            case "not_enrolled":
            case "unconfigured":
            case "unreachable":
            case "rejected":
            case "error":
              log.warn("relay mailbox not provisioned after instance enrollment", result);
              break;
          }
        })
        .catch((err) => {
          log.warn("relay mailbox provisioning after instance enrollment threw", {
            error: err instanceof Error ? err.message : String(err),
          });
        });
      return c.redirect(enrolledRedirect());
    } catch (err) {
      log.warn("token exchange errored", {
        error: err instanceof Error ? err.message : String(err),
      });
      return c.redirect(errorRedirect("network"));
    }
  });

  // Lightweight gate signal for the web onboarding: is this instance enrolled?
  app.get("/instance/enroll/status", (c) => {
    return c.json({ enrolled: getInstanceToken() !== null });
  });

  return app;
}
