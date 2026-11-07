// Runtime browser config for the SPA shell — pure builder,
// no fs deps (the container-boot script `scripts/generate-caddyfile.ts` does
// the write).
//
// The SPA bundle is deployment-agnostic; per-deployment browser config rides a
// tiny classic script, `runtime-config.js`, that `packages/web/index.html`
// references unconditionally. The container-boot script
// (`scripts/generate-caddyfile.ts`) writes it into the web root, so Caddy's
// `file_server` (which serves the production shell straight from disk — Hono
// never sees those document requests) and Hono's loopback `serveStatic` both
// deliver the same bytes. Serve-time HTML injection cannot work here: Caddy
// reads `index.html` from disk.
//
// `packages/web/public/runtime-config.js` ships an empty stub so dev servers
// and host runs (no boot script) serve valid JS with analytics disabled.

import { escapeForInlineScript } from "./inline-script.js";

export const RUNTIME_CONFIG_FILENAME = "runtime-config.js";

export interface RuntimeBrowserConfig {
  /** GA4 measurement ID; null/empty disables analytics. */
  gaMeasurementId: string | null;
}

export function buildRuntimeConfigJs(config: RuntimeBrowserConfig): string {
  const gaMeasurementId = config.gaMeasurementId?.trim() || null;
  // Always emit a full assignment — a boot with the ID removed must overwrite
  // a previous boot's value, not leave it dangling.
  const payload = gaMeasurementId ? { gaMeasurementId } : {};
  return `// Generated at container boot — do not edit. See packages/core/src/lib/runtime-config.ts
window.__ROME_RUNTIME_CONFIG__ = ${escapeForInlineScript(payload)};
`;
}
