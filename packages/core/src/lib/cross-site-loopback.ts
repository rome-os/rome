// Browser-origin rules for HTTP mutations that reach a listener directly over
// loopback. The rule and why it exists: docs/architecture/access-control.md#request-flow.
// The WebSocket form of the same rule lives in lib/ws-guardian-gate.ts.

import { isLoopbackHostname } from "@rome-os/libs/net";
import { isSameOriginMutationRequest } from "./mutation-origin.js";

interface BrowserRequestLike {
  method: string;
  headers: {
    get(name: string): string | null | undefined;
  };
}

interface MutationRequestLike extends BrowserRequestLike {
  url: string;
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function isUnsafeMethod(method: string): boolean {
  return !SAFE_METHODS.has(method.toUpperCase());
}

function fetchSite(request: BrowserRequestLike): string | undefined {
  return request.headers.get("sec-fetch-site")?.trim().toLowerCase() || undefined;
}

function isCrossSiteFetch(site: string | undefined): boolean {
  return site === "cross-site" || site === "same-site";
}

/** Whether an `Origin` value names a loopback host. */
export function hasLoopbackHostname(origin: string): boolean {
  try {
    return isLoopbackHostname(new URL(origin).hostname);
  } catch {
    return false;
  }
}

/**
 * Whether a mutation from a direct loopback caller came from a browser page
 * that is not the dashboard's own origin. Safe methods are never refused, and
 * a request with neither `Origin` nor `Sec-Fetch-Site` (curl, Rome's own
 * `fetch`) passes. A page on another loopback port counts as cross-site,
 * because browsers mark it `same-site`.
 */
export function isCrossSiteLoopbackMutation(request: MutationRequestLike): boolean {
  if (!isUnsafeMethod(request.method)) return false;
  const site = fetchSite(request);
  if (isCrossSiteFetch(site)) return true;
  const origin = request.headers.get("origin");
  if (!origin) return false;
  // A same-origin request under `Referrer-Policy: no-referrer` sends
  // `Origin: null`, so only Fetch Metadata can vouch for it.
  if (origin === "null") return site !== "same-origin";
  // Host alone does not prove the dashboard: a DNS-rebound name sends a
  // matching Origin and Host, so the Origin name must be loopback too.
  return !hasLoopbackHostname(origin) || !isSameOriginMutationRequest(request);
}

/**
 * Whether a mutation came from any browser page. For listeners that serve no
 * page of their own, such as the health daemon: a browser `Origin` or a
 * cross-site `Sec-Fetch-Site` on an unsafe method is never legitimate there.
 */
export function isBrowserMutation(request: BrowserRequestLike): boolean {
  if (!isUnsafeMethod(request.method)) return false;
  return Boolean(request.headers.get("origin")) || isCrossSiteFetch(fetchSite(request));
}
