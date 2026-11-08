import { isLoopbackHostname } from "@rome-os/libs/net";
import { createLogger } from "../logger.js";
import { readEnvInstanceOrigin } from "./instance-env.js";
import { resolveInstanceSlug } from "./runtime.js";

const log = createLogger("rome-cloud-origin");

function normalizeOrigin(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

/**
 * The Rome Cloud control-plane origin — the address the browser is redirected to,
 * the OIDC issuer we validate against, and the target for server-side fetches to
 * Rome Cloud. Sourced from `PANTHEON_BASE_ORIGIN`, else derived as
 * `https://<PANTHEON_DOMAIN>`. Returns `null` when neither is set (a self-hosted
 * instance with no Rome Cloud).
 *
 * There is a single Rome Cloud origin: the browser leg and the server-side leg
 * always agree. It must be reachable from wherever Rome runs — inside a
 * container, point `PANTHEON_BASE_ORIGIN` at a host-reachable address, not a bare
 * loopback (which resolves to the container itself).
 */
export function getRomeCloudOrigin(): string | null {
  const explicitOrigin = process.env.PANTHEON_BASE_ORIGIN;
  if (explicitOrigin) return normalizeOrigin(explicitOrigin);

  const domain = process.env.PANTHEON_DOMAIN;
  return domain ? `https://${domain}` : null;
}

/**
 * This instance's own public web origin — `https://<slug>.<domain>` (e.g.
 * `https://acme.romeos.cc`), the externally reachable address Rome Cloud serves
 * this tenant at. Distinct from {@link getRomeCloudOrigin}, which is the shared
 * Rome Cloud control-plane origin (`https://romeos.cc`), not this instance's
 * subdomain.
 *
 * `PANTHEON_INSTANCE_ORIGIN` is the authoritative value — Rome Cloud writes it into
 * the instance `.env` at provision (cloud-init), and it also overrides the derived
 * value when Rome is served at an address that isn't `https://<slug>.<PANTHEON_DOMAIN>`
 * (a custom domain, or a dev tunnel whose public host isn't that derivation).
 * Returns `null` when this instance has no public domain (no slug and/or no
 * `PANTHEON_DOMAIN`, e.g. a local self-hosted instance) so callers don't fabricate
 * an address.
 */
export function getConfiguredInstanceOrigin(env: NodeJS.ProcessEnv = process.env): string | null {
  const explicit = readEnvInstanceOrigin(env);
  if (explicit) return normalizeOrigin(explicit);

  const slug = resolveInstanceSlug(env);
  const domain = env.PANTHEON_DOMAIN?.trim().replace(/^\.+|\.+$/g, "");
  return slug && domain ? `https://${slug}.${domain}` : null;
}

/**
 * Parse a loopback callback origin, rejecting anything that is not one.
 *
 * This is a fail-closed guard against a malformed value, not a security
 * boundary — the environment is trusted configuration here, and anyone able to
 * set this can also set `PANTHEON_BASE_ORIGIN`. It exists because the value
 * becomes the `redirect_uri` of an OAuth flow, where a typo does not fail
 * loudly: it silently sends the browser somewhere that cannot answer.
 *
 * An explicit port is required. `URL.origin` drops an absent port, so
 * `http://127.0.0.1` would resolve to port 80 — a dead end that looks exactly
 * like the bug this variable fixes. Port `0` is rejected for the same reason:
 * it means "any free port" to the OS and cannot be dialled.
 *
 * A written-out `http://127.0.0.1:80` is rejected too, because `URL` normalizes
 * the scheme's default port away and leaves `port` empty. That is acceptable
 * rather than correct: the proxy this points at binds well above 1024, and
 * listening on 80 needs root, so the case cannot arise. Parsing the raw string
 * to tell the two apart would buy nothing.
 *
 * `URL.origin` also drops path, query and fragment, which is the right reading
 * of a value named for an origin. Credentials are rejected rather than dropped:
 * they are never part of a callback origin, so their presence means the value
 * was built wrong.
 *
 * It stays separate from {@link getConfiguredInstanceOrigin} on purpose. This
 * says only "where a loopback OAuth callback reaches me", not "my public
 * address". The configured origin also feeds the agent prompt and the Favors
 * `return_to`, and Rome Cloud drops any `return_to` host outside
 * `PANTHEON_DOMAIN` — which a loopback address is.
 */
function normalizeLoopbackCallbackOrigin(value: string | undefined): string | null {
  const raw = value?.trim();
  if (!raw) return null;
  let url: URL;
  try {
    // Also rejects an out-of-range port: `http://127.0.0.1:99999` throws here.
    url = new URL(raw);
  } catch {
    return logRejected("unparseable");
  }
  if (url.protocol !== "http:") return logRejected("not_http");
  if (!isLoopbackHostname(url.hostname)) return logRejected("not_loopback");
  if (!url.port || url.port === "0") return logRejected("no_usable_port");
  if (url.username || url.password) return logRejected("has_credentials");
  return url.origin;
}

/**
 * A rejected value falls through to the ordinary resolution chain, which on a
 * desktop instance lands on a loopback port nothing listens on. That failure is
 * indistinguishable from the bug this variable exists to fix, so name it rather
 * than leaving it to be rediscovered from an OAuth dead end.
 *
 * Logged at error, not warn: reaching here means someone set the variable and
 * got it wrong, so the address it was meant to override is being used instead.
 * The fallback keeps the instance serving, which is why this does not throw —
 * but a silently ignored explicit configuration is not a routine condition.
 *
 * Only the reason is logged. The value itself is operator-supplied and can
 * carry credentials, and this logger also ships to OTLP.
 */
function logRejected(reason: string): null {
  log.error("ignoring ROME_LOOPBACK_CALLBACK_ORIGIN", { reason });
  return null;
}

/**
 * This instance's own base origin — the address it is reachable at — resolved
 * from the instance's OWN configuration, never inferred from an incoming
 * request's (proxy-set, spoofable) Host headers. This is the authoritative
 * redirect target the instance hands to Rome Cloud during enrollment: the instance
 * knows where it lives, so it says so rather than trusting whatever host a proxy
 * chain happened to forward.
 *
 * Resolution: `ROME_LOOPBACK_CALLBACK_ORIGIN` (see
 * {@link normalizeLoopbackCallbackOrigin}), else the configured public origin
 * ({@link getConfiguredInstanceOrigin} — `PANTHEON_INSTANCE_ORIGIN` or the
 * `<slug>.<PANTHEON_DOMAIN>` derivation), else the local loopback address the
 * web server serves on (`WEB_PORT`, default 3000). A
 * deploy that sits behind a proxy (dev:all, cloud) is NOT reachable at its own
 * loopback, so it must set `PANTHEON_INSTANCE_ORIGIN` (or `PANTHEON_SLUG` +
 * `PANTHEON_DOMAIN`); desktop/local hit core directly on loopback and the default
 * is correct.
 */
export function getInstanceOrigin(env: NodeJS.ProcessEnv = process.env): string {
  const loopback = normalizeLoopbackCallbackOrigin(env.ROME_LOOPBACK_CALLBACK_ORIGIN);
  if (loopback) return loopback;

  const configured = getConfiguredInstanceOrigin(env);
  if (configured) return configured;
  const port = env.WEB_PORT?.trim() || "3000";
  return `http://localhost:${port}`;
}
