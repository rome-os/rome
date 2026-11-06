// Core's loopback proxy to the Rome credits inference gateway. The route in
// api/routes/rome-credits-proxy.ts serves it; the Codex app-server is its one
// client and presents the secret on every request (the adapter in
// agent/infrastructure/model/codex/ sets both up).

import { randomBytes } from "node:crypto";

/** Path prefix of the proxy. */
export const ROME_CREDITS_PROXY_PATH = "/_internal/rome-credits/v1";

/**
 * Secret the app-server presents to the proxy. It is random per process and
 * names no Rome Cloud credential.
 */
export const ROME_CREDITS_PROXY_SECRET = randomBytes(32).toString("base64url");
