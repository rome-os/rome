import type { MiddlewareHandler } from "hono";

/**
 * Default dynamic `/api/*` responses to `Cache-Control: no-store`.
 *
 * Rome is single-tenant and most API responses are mutable state (chat
 * sessions, settings, …). Leaving them cacheable lets a stale response — most
 * visibly a cached `/api/chat/sessions` list — hide freshly created or mutated
 * data from the dashboard even though it exists and is directly reachable.
 *
 * A route that declares its own `Cache-Control` (e.g. the app icon's
 * `public, max-age=300`) always wins: this only fills in the default when the
 * handler left the header unset. Note this middleware is mounted on the `/api`
 * sub-app only, so root-mounted static surfaces such as
 * `/app-assets/:appId/:version/*` and the dashboard shell are untouched.
 *
 * We set the default through `c.header(...)` rather than mutating
 * `c.res.headers` directly: app API handlers under `/api/apps/*` and
 * `/api/app-api/*` can return a raw `fetch()` result or `Response.redirect()`,
 * whose headers are immutable and reject an in-place `set()`. Hono's `c.header`
 * re-wraps a finalized response in a fresh `Response` with mutable headers, so
 * the default still applies to those responses instead of being silently lost.
 */
export function defaultApiCacheControl(): MiddlewareHandler {
  return async (c, next) => {
    await next();
    if (!c.res.headers.has("Cache-Control")) {
      c.header("Cache-Control", "no-store");
    }
  };
}
