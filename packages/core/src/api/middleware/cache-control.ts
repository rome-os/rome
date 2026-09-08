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
 */
export function defaultApiCacheControl(): MiddlewareHandler {
  return async (c, next) => {
    await next();
    if (c.res && !c.res.headers.has("Cache-Control")) {
      try {
        c.res.headers.set("Cache-Control", "no-store");
      } catch {
        // Some responses (e.g. certain redirects) expose immutable headers.
        // A missing default is acceptable; never let it break the response.
      }
    }
  };
}
