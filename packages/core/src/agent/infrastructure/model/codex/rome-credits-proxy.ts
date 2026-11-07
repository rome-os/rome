// The loopback proxy to the Rome credits inference gateway: the route in
// rome-credits-proxy-route.ts serves it, the app-server manager hands the
// secret to Codex, and nothing outside this folder reads either.

import { randomBytes } from "node:crypto";

/** Path prefix of the proxy. */
export const ROME_CREDITS_PROXY_PATH = "/_internal/rome-credits/v1";

/**
 * Secret the app-server presents to the proxy. It is random per process and
 * names no Rome Cloud credential.
 */
export const ROME_CREDITS_PROXY_SECRET = randomBytes(32).toString("base64url");
