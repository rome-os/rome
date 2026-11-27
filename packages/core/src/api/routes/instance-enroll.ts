import { randomBytes } from "node:crypto";
import { createPkce } from "@rome-os/libs/pkce";
import { hostname } from "node:os";
import { Hono } from "hono";
import {
  clearInstanceToken,
  getIdentityIssue,
  getInstanceIdentityEpoch,
  getInstanceToken,
  isInstanceLinked,
  persistInstanceToken,
  proveIdentity,
  type ProveIdentityResult,
} from "../../instance/instance-identity.js";
import { getInstanceOrigin, getRomeCloudOrigin } from "../../instance/rome-cloud-origin.js";
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
const COMPLETED_TTL_MS = 2 * 60_000;
const MAX_ENROLL_STATES = 64;
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
  epoch: number;
}

function sweepExpired(entries: Map<string, { expiresAt: number }>, now: number): void {
  for (const [state, entry] of entries) {
    if (entry.expiresAt <= now) entries.delete(state);
  }
}

function rememberState<T>(entries: Map<string, T>, state: string, entry: T): void {
  entries.set(state, entry);
  if (entries.size > MAX_ENROLL_STATES) {
    const oldest = entries.keys().next();
    if (!oldest.done) entries.delete(oldest.value);
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
  fetchImpl?: typeof fetch;
  now?: () => number;
}

type EnrollStartGate = { ok: true } | { ok: false; status: 409 | 503; error: string };

async function clearRejectedInstanceState(
  deps: ApiDeps,
  reason: "revoked" | "unknown" | "key_conflict",
) {
  const clearPromise = clearInstanceToken(deps.settingsRepo);
  const clearEpoch = getInstanceIdentityEpoch();
  await clearPromise;
  if (getInstanceIdentityEpoch() !== clearEpoch) return;
  await deps.settingsRepo.delete(RELAY_SETTING_KEY);
  if (getInstanceIdentityEpoch() !== clearEpoch) return;
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
  seams: InstanceEnrollSeams,
  waitForCleanup: () => Promise<void>,
  clearRejected: (reason: "revoked" | "unknown" | "key_conflict") => Promise<void>,
): Promise<EnrollStartGate> {
  await waitForCleanup();
  if (!isInstanceLinked()) return { ok: true };

  const checkEpoch = getInstanceIdentityEpoch();
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
    case "key_conflict":
      await waitForCleanup();
      if (getInstanceIdentityEpoch() !== checkEpoch) {
        return isInstanceLinked()
          ? { ok: false, status: 409, error: "already_enrolled" }
          : { ok: true };
      }
      await clearRejected(auth.status);
      return isInstanceLinked()
        ? { ok: false, status: 409, error: "already_enrolled" }
        : { ok: true };
    case "no_token":
      return { ok: true };
    case "unconfigured":
      return { ok: false, status: 503, error: "pantheon_origin_unconfigured" };
    case "unreachable":
      return { ok: false, status: 503, error: "identity_unreachable" };
    case "clock_skew":
    case "signer_unavailable":
    case "audience_mismatch":
    case "upgrade_required":
      return { ok: false, status: 503, error: auth.status };
  }
}

export function instanceEnrollRoutes(deps: ApiDeps, seams: InstanceEnrollSeams = {}): Hono {
  const app = new Hono();
  const fetchImpl = seams.fetchImpl ?? globalThis.fetch;
  const now = seams.now ?? Date.now;
  const pending = new Map<string, PendingEnroll>();
  const inFlight = new Map<string, Promise<string>>();
  let lastCompleted: { state: string; expiresAt: number; epoch: number } | null = null;
  let activeCleanup: Promise<void> | null = null;
  let activePersist: { epoch: number; promise: Promise<void> } | null = null;
  const clearCompleted = () => {
    lastCompleted = null;
  };
  const waitForCleanup = async () => {
    while (activeCleanup) {
      try {
        await activeCleanup;
      } catch {
        // The initiating request handles its own cleanup failure.
      }
    }
  };
  const waitForSettled = async () => {
    while (true) {
      const pendingOp =
        activeCleanup ??
        (activePersist && activePersist.epoch === getInstanceIdentityEpoch()
          ? activePersist.promise
          : null);
      if (!pendingOp) return;
      try {
        await pendingOp;
      } catch {
        // The initiating request handles its own failure.
      }
    }
  };
  const runCleanup = async (reason: "revoked" | "unknown" | "key_conflict") => {
    clearCompleted();
    const cleanup = clearRejectedInstanceState(deps, reason).finally(() => {
      if (activeCleanup === cleanup) activeCleanup = null;
    });
    activeCleanup = cleanup;
    await cleanup;
  };

  // The verifier never leaves this process; only the challenge rides the
  // browser leg.
  app.post("/instance/enroll/start", async (c) => {
    const enrollment = await checkExistingEnrollment(seams, waitForSettled, runCleanup);
    if (!enrollment.ok) {
      return c.json({ error: enrollment.error }, enrollment.status);
    }

    const origin = getRomeCloudOrigin();
    if (!origin) {
      return c.json({ error: "pantheon_origin_unconfigured" }, 503);
    }

    await waitForSettled();
    if (isInstanceLinked()) {
      return c.json({ error: "already_enrolled" }, 409);
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

    const startedAt = now();
    sweepExpired(pending, startedAt);
    if (lastCompleted && lastCompleted.expiresAt <= startedAt) clearCompleted();
    const pkce = createPkce();
    const state = randomBytes(16).toString("base64url");
    rememberState(pending, state, {
      verifier: pkce.verifier,
      expiresAt: startedAt + PENDING_TTL_MS,
      epoch: getInstanceIdentityEpoch(),
    });

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
    if (!state) {
      return c.redirect(errorRedirect("state"));
    }

    const active = inFlight.get(state);
    if (active) return c.redirect(await active);

    if (activeCleanup) {
      await waitForCleanup();
      const activeAfterCleanup = inFlight.get(state);
      if (activeAfterCleanup) return c.redirect(await activeAfterCleanup);
    }

    const requestedAt = now();
    // The first callback for an expired pending state still reports expiry.
    const entry = pending.get(state);
    const completedEntry = lastCompleted?.state === state ? lastCompleted : null;
    sweepExpired(pending, requestedAt);
    if (lastCompleted && lastCompleted.expiresAt <= requestedAt) clearCompleted();

    if (completedEntry) {
      if (
        completedEntry.expiresAt > requestedAt &&
        completedEntry.epoch === getInstanceIdentityEpoch() &&
        (isInstanceLinked() || getInstanceToken() !== null)
      ) {
        return c.redirect(enrolledRedirect());
      }
      if (lastCompleted?.state === state) clearCompleted();
      return c.redirect(errorRedirect("state"));
    }

    if (!entry) return c.redirect(errorRedirect("state"));
    pending.delete(state);
    if (entry.expiresAt <= requestedAt) {
      return c.redirect(errorRedirect("expired"));
    }
    if (entry.epoch !== getInstanceIdentityEpoch()) {
      return c.redirect(errorRedirect("state"));
    }
    const code = c.req.query("code");
    const oauthError = c.req.query("error");
    if (oauthError || !code) {
      return c.redirect(errorRedirect("denied"));
    }

    const origin = getRomeCloudOrigin();
    if (!origin) {
      return c.redirect(errorRedirect("unconfigured"));
    }

    if (inFlight.size >= MAX_ENROLL_STATES) {
      log.warn("instance enrollment exchange capacity reached");
      return c.redirect(errorRedirect("exchange"));
    }

    // Publish the promise before the exchange starts so duplicates share its result.
    const promise = Promise.resolve()
      .then(async () => {
        try {
          const response = await fetchImpl(new URL("/api/instance/token", origin), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ code, code_verifier: entry.verifier }),
            signal: AbortSignal.timeout(30_000),
          });
          if (!response.ok) {
            const reason = (await response.json().catch(() => null)) as { error?: unknown } | null;
            const detail =
              typeof reason?.error === "string" ? reason.error : `http_${response.status}`;
            log.warn("token exchange failed", { detail });
            return errorRedirect("exchange");
          }

          const data = (await response.json().catch(() => null)) as TokenResponse | null;
          const token = typeof data?.instanceToken === "string" ? data.instanceToken : null;
          const instanceId = typeof data?.instanceId === "string" ? data.instanceId : null;
          if (!token || !instanceId) {
            return errorRedirect("malformed");
          }

          if (activeCleanup) await waitForCleanup();
          if (entry.epoch !== getInstanceIdentityEpoch()) {
            return errorRedirect("state");
          }

          const persistPromise = persistInstanceToken(deps.settingsRepo, token, {
            expectedEpoch: entry.epoch,
          });
          const enrollmentEpoch = getInstanceIdentityEpoch();
          const trackedPersist = persistPromise
            .then(
              () => undefined,
              () => undefined,
            )
            .finally(() => {
              if (activePersist?.promise === trackedPersist) activePersist = null;
            });
          activePersist = { epoch: enrollmentEpoch, promise: trackedPersist };
          const linked = await persistPromise;
          if (linked?.status === "key_conflict") return errorRedirect("key_conflict");
          if (enrollmentEpoch === entry.epoch || getInstanceIdentityEpoch() !== enrollmentEpoch) {
            return errorRedirect("state");
          }
          if (linked && linked.status !== "ok") {
            log.warn("instance enrolled but the signer key is not registered yet", {
              status: linked.status,
            });
          }
          void deps.provisionAfterLink?.();
          log.info("instance enrolled via in-app OAuth", { instanceId });
          lastCompleted = {
            state,
            expiresAt: now() + COMPLETED_TTL_MS,
            epoch: enrollmentEpoch,
          };
          return enrolledRedirect();
        } catch (err) {
          log.warn("token exchange errored", {
            error: err instanceof Error ? err.message : String(err),
          });
          return errorRedirect("network");
        }
      })
      .finally(() => {
        inFlight.delete(state);
      });
    inFlight.set(state, promise);
    return c.redirect(await promise);
  });

  // Lightweight gate signal for the web onboarding: is this instance enrolled?
  app.get("/instance/enroll/status", (c) => {
    return c.json({ enrolled: isInstanceLinked(), issue: getIdentityIssue() });
  });

  return app;
}
