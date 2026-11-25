// Which paths are public, and which are an app's, whose own access decides
// them. Contract: docs/architecture/access-control.md.

import { decodeAppIdPathSegment, InvalidAppApiPathError } from "./helpers.js";

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
  // The unauthenticated SPA bootstrap probe.
  "/api/bootstrap",
  "/api/onboard/*",
  "/api/instance/enroll/*",
  // A blank warm-pool instance adopts its tenant identity here, before any
  // guardian exists. Exact path: the request needs a provisioned instance token
  // that Rome Cloud accepts, and the route refuses anything but a blank,
  // unlinked, hosted instance.
  "/api/instance/adopt",
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
export function isPublicPath(forwardedUri: string): boolean {
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

/** The app whose dashboard surface a path is on, or null for a path that is Rome's own. */
export function dashboardAppId(forwardedUri: string): string | null {
  const path = forwardedUri.split("?")[0];
  // Host-owned paths must not inherit either public or app-scoped email access.
  const match = path.match(/^\/api\/apps\/([^/]+)\/(.+)$/);
  if (!match || /^publish\/?$/.test(match[2])) return null;

  try {
    return decodeAppIdPathSegment(match[1]);
  } catch (err) {
    if (err instanceof InvalidAppApiPathError) return null;
    throw err;
  }
}

/** The app whose API a path is on, or null for any other path. */
export function appApiAppId(forwardedUri: string): string | null {
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
