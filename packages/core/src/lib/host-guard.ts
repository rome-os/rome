// Host allow-list for the internal listener. Why it exists and which front
// doors depend on it: docs/architecture/access-control.md#listener-host-names.

import { isIP } from "node:net";
import type { MiddlewareHandler } from "hono";
import { isLoopbackHostname } from "@rome-os/libs/net";
import { createLogger } from "../logger.js";

const log = createLogger("host-guard");

/** The status a refused request gets: the listener does not serve that name. */
export const MISDIRECTED_REQUEST = 421;

// A bracketed IPv6 literal or a plain name, then an optional port. Anything
// else (userinfo, a path, a second colon) is not a Host a browser sends.
const HOST_SHAPE = /^(\[[0-9a-f:.]+\]|[a-z0-9._-]+)(?::\d{1,5})?$/;

/**
 * Whether a request whose raw `Host` header is `rawHost` may reach the
 * internal listener. Pass the `Host` header itself, never `X-Forwarded-Host`:
 * a page can set the latter on a same-origin fetch, but `Host` is a forbidden
 * header it cannot set.
 *
 * Allows a missing Host, loopback names (`localhost`, `*.localhost`,
 * `127.0.0.1`, `[::1]`), any IP literal, and Tailscale `*.ts.net` names. Every
 * other name could be DNS-rebound to loopback, so it is refused.
 */
export function isAllowedInternalHost(rawHost: string | undefined): boolean {
  if (rawHost === undefined || rawHost === "") return true;
  const match = HOST_SHAPE.exec(rawHost.trim().toLowerCase());
  if (!match) return false;
  const hostname = match[1];
  if (isLoopbackHostname(hostname)) return true;
  const bare = hostname.startsWith("[") ? hostname.slice(1, -1) : hostname;
  if (isIP(bare) !== 0) return true;
  // `tailscale serve` proxies to this listener and keeps the tailnet Host.
  // Tailscale owns the ts.net zone, so no attacker can point a name there at
  // 127.0.0.1.
  return hostname.endsWith(".ts.net");
}

/** Hono middleware answering 421 for a request whose Host fails `isAllowedInternalHost`. */
export function internalHostGuard(): MiddlewareHandler {
  return async (c, next) => {
    const host = c.req.header("host");
    if (!isAllowedInternalHost(host)) {
      log.warn("refused request addressed to a non-loopback name", {
        host,
        path: c.req.path,
      });
      return c.text("Misdirected Request", MISDIRECTED_REQUEST);
    }
    await next();
  };
}

/**
 * Puts the public name back in `host` before app handlers see the headers.
 * Caddy addresses this listener by its upstream Host and carries the public
 * name in `X-Forwarded-Host`, and apps read `host` as the name the client
 * addressed. Mutates `headers`, whose keys must be lower-case.
 */
export function restorePublicHost(headers: Record<string, string>): void {
  const forwarded = headers["x-forwarded-host"]?.split(",")[0]?.trim();
  if (forwarded) headers.host = forwarded;
}
