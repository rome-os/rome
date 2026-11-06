import { timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import {
  ROME_CREDITS_PROXY_PATH,
  ROME_CREDITS_PROXY_SECRET,
} from "../../core/rome-credits-proxy.js";
import { cloudBearer } from "../../lib/instance-identity.js";
import { getRomeCloudOrigin } from "../../lib/rome-cloud-origin.js";
import { isLoopbackInternalApiHost } from "./discord-cli.js";

// Headers that describe the Codex-to-core hop or carry a credential.
const DROP_REQUEST_HEADERS = new Set([
  "authorization",
  "connection",
  "content-length",
  "cookie",
  "host",
  "accept-encoding",
]);
// Fetch has already decoded the body, so its encoding headers no longer describe it.
const DROP_RESPONSE_HEADERS = new Set([
  "connection",
  "content-encoding",
  "content-length",
  "transfer-encoding",
]);

function hasProxyKey(authorization: string | undefined): boolean {
  const presented = Buffer.from(authorization ?? "");
  const expected = Buffer.from(`Bearer ${ROME_CREDITS_PROXY_SECRET}`);
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}

/**
 * Forwards Codex's inference requests to Rome Cloud's `/v1/*` with the
 * instance's Rome Cloud bearer, so Codex never holds that credential. Lives
 * outside `/api`, which Caddy proxies, and refuses to register on a listener
 * that is not loopback. The status, headers and body, including server-sent
 * event streams, return as Rome Cloud sent them.
 */
export function romeCreditsProxyRoutes(
  internalApiHost: string,
  fetchImpl: typeof fetch = globalThis.fetch,
): Hono {
  if (!isLoopbackInternalApiHost(internalApiHost)) {
    throw new Error("The Rome credits proxy requires the internal API server to bind to loopback");
  }
  const app = new Hono();

  app.all(`${ROME_CREDITS_PROXY_PATH}/*`, async (c) => {
    if (!hasProxyKey(c.req.header("authorization"))) return c.json({ error: "unauthorized" }, 401);
    const origin = getRomeCloudOrigin();
    const bearer = await cloudBearer();
    if (!origin || !bearer) return c.json({ error: "not_linked" }, 503);

    // Only the inference gateway is reachable, whatever the path holds.
    const incoming = new URL(c.req.url);
    const target = new URL(origin);
    target.pathname = incoming.pathname.replace(/^\/_internal\/rome-credits/, "");
    target.search = incoming.search;
    if (!target.pathname.startsWith("/v1/")) return c.json({ error: "not_found" }, 404);

    const headers = new Headers();
    for (const [name, value] of c.req.raw.headers) {
      if (!DROP_REQUEST_HEADERS.has(name)) headers.set(name, value);
    }
    headers.set("authorization", `Bearer ${bearer}`);
    const hasBody = c.req.method !== "GET" && c.req.method !== "HEAD";
    let upstream: Response;
    try {
      upstream = await fetchImpl(target, {
        method: c.req.method,
        headers,
        body: hasBody ? await c.req.arrayBuffer() : undefined,
        redirect: "manual",
        signal: c.req.raw.signal,
      });
    } catch {
      return c.json({ error: "rome_cloud_unreachable" }, 502);
    }
    const responseHeaders = new Headers();
    for (const [name, value] of upstream.headers) {
      if (!DROP_RESPONSE_HEADERS.has(name)) responseHeaders.set(name, value);
    }
    return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
  });

  return app;
}
