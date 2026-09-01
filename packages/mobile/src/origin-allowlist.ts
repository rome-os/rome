/**
 * Origin policy for the Rome mobile WebView shell.
 *
 * The shell may load three classes of origin in the WebView:
 *   1. the Rome Cloud origin (exact) — the account home the shell starts at,
 *   2. any single-label instance subdomain under the instance domain
 *      (`https://<slug>.<instanceDomain>`, default port only),
 *   3. explicitly-permitted auth origins (exact) — the Google sign-in host the
 *      in-WebView login chain renders.
 * Any other valid HTTPS target is handed to the system browser; anything else
 * (non-HTTPS, custom scheme, malformed) is dropped fail-closed. This module is
 * the pure decision logic — WebView wiring and side effects live in `App.tsx`.
 *
 * Usage: build the policy once from build-time config via `buildOriginPolicy`,
 * then check each navigation with `resolveNavigation`.
 */

/**
 * Split a raw origin-list config string (e.g. `EXPO_PUBLIC_ROME_AUTH_ORIGINS`)
 * into candidate origin tokens. Accepts comma- and/or whitespace-separated
 * values, trims each, and drops empties. Purely a format-level split: it does
 * **not** validate that each token is a valid HTTPS origin — that is
 * `buildOriginPolicy`'s job, which normalizes and silently drops anything
 * non-HTTPS or unparseable.
 */
export function parseOriginList(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/[\s,]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

export interface OriginPolicyConfig {
  /** Rome Cloud's public origin — the shell's home, e.g. `https://rome.example`. */
  romeCloudOrigin: string;
  /**
   * Domain suffix instance origins live under: `https://<slug>.<instanceDomain>`
   * is in-shell. A bare hostname (no scheme, port, or path).
   */
  instanceDomain: string;
  /** Additional exact in-shell origins (the Google sign-in host, extras from config). */
  authOrigins?: string[];
}

/** Built once via `buildOriginPolicy`; immutable at runtime. */
export interface OriginPolicy {
  /** Exact-match in-shell origins: Rome Cloud + validated auth origins. */
  exactOrigins: ReadonlySet<string>;
  /** Lowercase bare hostname; `https://<label>.<instanceDomain>` is in-shell. */
  instanceDomain: string;
  /**
   * Rome Cloud's normalized origin, kept separately from `exactOrigins` (which
   * also contains auth origins) so callers can distinguish "came from
   * Rome Cloud" from "came from a trusted auth host" — the remembered-instance
   * store only persists on an explicit Rome Cloud → instance hop.
   */
  romeCloudOrigin: string;
}

/**
 * Normalize a URL to its `origin` (scheme + host + port), accepting only
 * `https:`. Returns `null` for anything non-HTTPS or unparseable — so custom
 * schemes, `http:`, `data:`, `about:blank`, and malformed input are all
 * rejected by callers. URL-embedded credentials (`https://user:pass@host`)
 * are also rejected: they are deprecated, can trigger surprising auth
 * behavior, and make destination checks easier to confuse, so a navigation
 * boundary treats them as fail-closed rather than trusted.
 *
 * Relies on a spec-compliant global `URL`. React Native's built-in `URL` is an
 * incomplete polyfill (notably `.origin`), so any entry point importing this
 * module MUST first import `react-native-url-polyfill/auto` (see `App.tsx`);
 * otherwise origins are parsed incorrectly and the policy can be bypassed.
 * Under Node-based test runners the platform `URL` is already compliant.
 */
function normalizeHttpsOrigin(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (url.username !== "" || url.password !== "") return null;
  return url.origin;
}

/**
 * Validate + normalize a configured instance domain to a lowercase bare
 * hostname, via the same URL parser navigation URLs go through (so IDN and
 * case normalization can't diverge between config and checks). Returns `null`
 * if the value smuggles in anything beyond a hostname (scheme, port, path,
 * query, fragment, credentials).
 */
function normalizeHostname(value: string): string | null {
  let url: URL;
  try {
    url = new URL(`https://${value}`);
  } catch {
    return null;
  }
  if (url.username !== "" || url.password !== "" || url.port !== "") return null;
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") return null;
  return url.hostname;
}

/**
 * Build the immutable origin policy from build-time config, once, so the
 * per-navigation check is cheap rather than re-normalizing config on every
 * event. Throws if `romeCloudOrigin` or `instanceDomain` is invalid: failing
 * loudly at startup beats a silently-empty policy that blocks every navigation
 * (including the initial load) and surfaces only as a blank WebView. Invalid
 * `authOrigins` entries are silently dropped (optional, additive config).
 */
export function buildOriginPolicy(config: OriginPolicyConfig): OriginPolicy {
  const romeCloud = normalizeHttpsOrigin(config.romeCloudOrigin);
  if (romeCloud === null) {
    throw new Error(
      `[rome-mobile] romeCloudOrigin is not a valid HTTPS URL: ${config.romeCloudOrigin}`,
    );
  }
  const instanceDomain = normalizeHostname(config.instanceDomain);
  if (instanceDomain === null) {
    throw new Error(
      `[rome-mobile] instanceDomain is not a bare hostname: ${config.instanceDomain}`,
    );
  }
  // A single-label domain (`com`, `localhost`) would make `isInstanceUrl`
  // classify arbitrary hosts (`https://evil.com`) as in-shell — a silently
  // blown-open trust boundary. Real instance domains are always multi-label
  // (`rome.example`), so fail fast instead. (Deliberately NOT a full
  // public-suffix-list check: bundling the PSL into a thin shell is out of
  // proportion, and deployment config controls this value.)
  // (`endsWith(".")` guards the trailing-dot form `com.`, which contains a
  // dot but is still a single label.)
  if (!instanceDomain.includes(".") || instanceDomain.endsWith(".")) {
    throw new Error(
      `[rome-mobile] instanceDomain must be a multi-label hostname (got: ${config.instanceDomain})`,
    );
  }

  const exactOrigins = new Set<string>([romeCloud]);
  for (const extra of config.authOrigins ?? []) {
    const normalized = normalizeHttpsOrigin(extra);
    if (normalized !== null) exactOrigins.add(normalized);
  }
  return { exactOrigins, instanceDomain, romeCloudOrigin: romeCloud };
}

/**
 * Instance-slug rules, mirroring Rome Cloud's authoritative validation
 * (the Rome Cloud validation module's `SAFE_SLUG_RE` +
 * `RESERVED_SLUGS`). Not every single-label sibling of the instance domain is
 * a user instance — `demo.<domain>` is the store preview,
 * `public-assets.<domain>` serves static content, `staging.<domain>` is the
 * staging Rome Cloud — so only hosts whose label is a registrable slug are
 * treated as instances. Everything else routes like any other HTTPS target
 * (system browser) and is never remembered as "my Rome".
 *
 * KEEP IN SYNC with Rome Cloud's validation: this is a best-effort mirror, not
 * a source of truth. The extra labels below are operational siblings that the
 * slug regex would otherwise accept but Rome Cloud does not (yet) reserve.
 */
const INSTANCE_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,30}[a-z0-9]$/;
const RESERVED_INSTANCE_LABELS: ReadonlySet<string> = new Set([
  // Rome Cloud's RESERVED_SLUGS:
  "www",
  "api",
  "admin",
  "app",
  "dashboard",
  "status",
  "docs",
  "help",
  "support",
  "billing",
  // Known operational siblings that are not user instances:
  "demo",
  "public-assets",
  "staging",
]);

/**
 * True iff `targetUrl` is HTTPS on the default port and its host is exactly one
 * DNS label under the instance domain (`<label>.<instanceDomain>`), where the
 * label is a valid, non-reserved instance slug (see `INSTANCE_SLUG_RE` /
 * `RESERVED_INSTANCE_LABELS` above). The dot boundary is enforced by
 * construction (suffix `.` + domain), so lookalikes (`evil-rome.example`) and
 * suffix extensions (`abc.rome.example.evil.tld`) don't match; a multi-label
 * host (`a.b.rome.example`) is rejected because the slug regex admits no dot.
 * The apex itself is NOT an instance — it matches Rome Cloud's exact entry
 * instead. URL-embedded credentials are rejected fail-closed (same rationale
 * as `normalizeHttpsOrigin`; checked here too because the instance store calls
 * this directly).
 */
export function isInstanceUrl(targetUrl: string, policy: OriginPolicy): boolean {
  let url: URL;
  try {
    url = new URL(targetUrl);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.port !== "") return false;
  if (url.username !== "" || url.password !== "") return false;
  const suffix = `.${policy.instanceDomain}`;
  if (!url.hostname.endsWith(suffix)) return false;
  const label = url.hostname.slice(0, url.hostname.length - suffix.length);
  return INSTANCE_SLUG_RE.test(label) && !RESERVED_INSTANCE_LABELS.has(label);
}

/**
 * What the shell should do with a navigation — both new-window requests
 * (`target="_blank"` / `window.open()`) and same-window top-level navigations:
 *
 * - `in-shell`  — Rome Cloud, an instance subdomain, or an auth origin: load it
 *                 in the WebView.
 * - `external`  — a valid off-list HTTPS target: hand it to the system browser.
 * - `drop`      — invalid, non-HTTPS, or otherwise unsafe: do nothing.
 */
export type NavigationAction =
  | { kind: "in-shell"; url: string }
  | { kind: "external"; url: string }
  | { kind: "drop" };

/**
 * Pure routing decision for a navigation. Side effects (navigation,
 * `Linking.openURL`) live in the caller so this stays unit-testable without
 * React Native.
 */
export function resolveNavigation(targetUrl: string, policy: OriginPolicy): NavigationAction {
  const origin = normalizeHttpsOrigin(targetUrl);
  if (origin === null) return { kind: "drop" };
  if (policy.exactOrigins.has(origin) || isInstanceUrl(targetUrl, policy)) {
    return { kind: "in-shell", url: targetUrl };
  }
  return { kind: "external", url: targetUrl };
}

/**
 * Redact a URL for logging: keep only origin + path for http(s), dropping the
 * query and fragment. Navigation URLs in the login chain carry transient auth
 * secrets (OAuth `state`, `code_challenge`, provider callback data) in their
 * query string, which must not land in device logs / crash reports. Non-HTTP
 * schemes keep only the scheme: the WHATWG parser puts a `javascript:`/`data:`
 * payload entirely in `pathname`, so origin+pathname would echo it verbatim.
 * Returns a fixed marker for anything unparseable rather than echoing raw
 * input.
 */
export function redactUrlForLog(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      return `${url.protocol}[redacted]`;
    }
    return `${url.origin}${url.pathname}`;
  } catch {
    return "[unparsable url]";
  }
}
