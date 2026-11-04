import type { MiddlewareHandler } from "hono";
import { isCrossSiteLoopbackMutation } from "../../lib/cross-site-loopback.js";
import { isTrustedLoopbackCaller } from "../../lib/guardian-session.js";
import { createLogger } from "../../logger.js";

const log = createLogger("api");

/**
 * Answers 403 to a mutation from a direct loopback caller (the trusted
 * in-container caller of lib/trusted-loopback.ts) when a browser page on
 * another origin sent it. Proxied traffic carries `X-Forwarded-For` and passes
 * through untouched. Register before every route, because Hono runs middleware
 * only for routes registered after it.
 */
export function refuseCrossSiteLoopbackMutations(): MiddlewareHandler {
  return async (c, next) => {
    if (isTrustedLoopbackCaller(c) && isCrossSiteLoopbackMutation(c.req.raw)) {
      log.warn("Refused a cross-site browser mutation over loopback", {
        method: c.req.method,
        path: c.req.path,
        origin: c.req.header("origin") ?? null,
        secFetchSite: c.req.header("sec-fetch-site") ?? null,
      });
      return c.json({ error: "Forbidden" }, 403);
    }
    await next();
  };
}
