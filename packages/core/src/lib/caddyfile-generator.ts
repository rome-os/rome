// Caddyfile generation — pure string ops, no DB/fs/path deps.
//
// The Caddyfile is generated in two places: at container boot from
// `scripts/generate-caddyfile.ts` (before the daemon comes up) and at
// runtime from `lib/public-access.ts` (when the publicAccess setting
// changes via API and we hot-reload Caddy). Both call this function so
// the output stays in lockstep.

import { getEmbeddedAppHref, getFullAppHref } from "./app-routes.js";
import { normalizePublicAccessConfig, type PublicAccessConfig } from "./public-access-config.js";
import { RUNTIME_CONFIG_FILENAME } from "./runtime-config.js";

const DEFAULT_WEB_ROOT = "/app/packages/web/dist";

// The one place the served-SPA disk root is resolved. The boot script writes
// `runtime-config.js` into this same root — resolving it anywhere
// else risks Caddy serving a shell whose runtime config was written elsewhere.
export function resolveWebRoot(): string {
  return process.env.INTERNAL_API_WEB_ROOT ?? DEFAULT_WEB_ROOT;
}

function indent(block: string, depth: number): string {
  const pad = "\t".repeat(depth);
  return block
    .replace(/^\n+|\n+$/g, "")
    .split("\n")
    .map((line) => (line.length === 0 ? "" : pad + line))
    .join("\n");
}

export function generateCaddyfile(config: PublicAccessConfig): string {
  const normalized = normalizePublicAccessConfig(config);
  const upstream = `127.0.0.1:${process.env.INTERNAL_API_PORT ?? "4141"}`;
  // The Dockerfile populates INTERNAL_API_WEB_ROOT with the path to the
  // built SPA. Caddy serves it directly so unauthenticated visitors get
  // the shell + Vite bundle, and the SPA does its own redirect-to-login.
  const webRoot = resolveWebRoot();

  const proxy = `reverse_proxy ${upstream}`;
  const forwardAuth = `forward_auth ${upstream} {
\turi /api/auth/verify
\tcopy_headers X-Rome-User-Id X-Rome-Visitor-Account-Id X-Rome-Visitor-Email
\t# App WebSocket upgrades live under /api/apps/* and /api/app-api/*, so they
\t# stay in @dynamic to inherit the cookie gate. forward_auth otherwise
\t# forwards Upgrade/Connection verbatim to the verify probe and the handshake
\t# never returns (caddyserver/caddy#5430); stripping Connection from the
\t# probe copy only (header_up edits forward_auth's copy; the downstream
\t# reverse_proxy still upgrades the original request) lets the upgrade through.
\theader_up -Connection
}`;
  // Boot-written runtime browser config. An explicit handle in
  // BOTH modes: the content changes across container boots so it must never get
  // the immutable-asset cache header, and in public-access mode the fallback
  // would otherwise rewrite it to the gateway page — handing the browser HTML
  // where the shell's <script src="/runtime-config.js"> expects JS.
  const runtimeConfigHandle = `
handle /${RUNTIME_CONFIG_FILENAME} {
\tencode zstd gzip
\theader Cache-Control "no-cache"
\tfile_server
}
`.trim();

  let body: string;

  if (!normalized.enableAccessControl) {
    // Caddy serves the SPA (hashed bundles + client-routed shell) straight
    // from disk via `file_server`, so Hono is reserved for the agent/API.
    // Only the dynamic surfaces below are proxied:
    //
    //   - `@dynamic` (`/api/*`, `/webhooks/*`, `/app-assets/*`, `/app-og/*`)
    //     goes through `forward_auth` — the verify endpoint
    //     (`/api/auth/verify`) reads `X-Forwarded-Uri` and gates `/api/*` on
    //     a cookie. Non-`/api/*` paths (webhooks have their own X-API-Key,
    //     app bundles and social card images are public) get a 204, so this
    //     is a pass-through for them.
    //   - SPA routes / static assets are public anyway (verify 204s every
    //     non-`/api/*` path), so serving them from Caddy drops a pointless
    //     double round-trip to Hono with zero change to the auth posture.
    //     Unknown paths fall back to `index.html` for the client router.
    //     Hono keeps its own copy for loopback/tailnet callers that reach
    //     `:4141` without going via Caddy.
    //   - `@appDocs` (`/apps/*`, `/full/apps/*`) is the shell too, but served
    //     by Hono so the social meta can be swapped per app. Public, no
    //     forward_auth: the shell was public from disk already.
    //
    // WebSocket-bearing paths (`/ws/*`, `/desktop-proxy*`) are split out
    // because \`forward_auth\` forwards Upgrade/Connection headers verbatim
    // to the auth probe, so the auth server sees a WS-upgrade request
    // instead of a plain GET and the proxy never returns. Confirmed in
    // caddyserver/caddy#5430 (closed by the maintainers as "by design —
    // use the workaround"). They proxy straight through here. The
    // documented workaround if we ever fold them back in is
    // \`header_up -Connection\` inside the \`forward_auth { ... }\` block,
    // which strips the upgrade headers on the probe copy only.
    body = `
root * ${webRoot}
@wsUpgrade path /ws/* /desktop-proxy /desktop-proxy/*
handle @wsUpgrade {
\t${proxy}
}
@dynamic path /api /api/* /webhooks /webhooks/* /app-assets /app-assets/* /app-og /app-og/*
handle @dynamic {
${indent(forwardAuth, 1)}
\t${proxy}
}
${runtimeConfigHandle}
@spaAssets {
\tpath /static/* /assets/* /icon.svg /favicon.ico
\t# Caddy 2.6 needs an explicit candidate; a bare file matcher can match the root.
\tfile {path}
}
handle @spaAssets {
\tencode zstd gzip
\theader Cache-Control "public, max-age=31536000, immutable"
\tfile_server
}
@missingSpaAssets path /static/* /assets/* /icon.svg /favicon.ico
handle @missingSpaAssets {
\trespond 404
}
@appDocs path /apps /apps/* /full/apps /full/apps/*
handle @appDocs {
\tencode zstd gzip
\t${proxy}
}
handle {
\troot * ${webRoot}
\ttry_files {path} /index.html
\tencode zstd gzip
\theader Cache-Control "no-cache"
\tfile_server
}
`.trim();
  } else {
    // Public-access mode: the public edge exposes only an allowlisted set
    // of apps + a gateway landing page. Allowlisted app shells are proxied to
    // Hono for per-app social meta, same as their `/api/*` paths.
    const publicAppBlocks = normalized.allowedApps
      .map((appId) => {
        const appIdSegment = encodeURIComponent(appId);
        return `
handle /api/apps/${appIdSegment} {
\t${proxy}
}
handle /api/apps/${appIdSegment}/* {
\t${proxy}
}
handle /api/app-api/${appIdSegment} {
\t${proxy}
}
handle /api/app-api/${appIdSegment}/* {
\t${proxy}
}
handle /app-assets/${appIdSegment}/* {
\t${proxy}
}
handle ${getEmbeddedAppHref(appId)} {
\tencode zstd gzip
\t${proxy}
}
handle ${getEmbeddedAppHref(appId)}/* {
\tencode zstd gzip
\t${proxy}
}
handle ${getFullAppHref(appId)} {
\tencode zstd gzip
\t${proxy}
}
handle ${getFullAppHref(appId)}/* {
\tencode zstd gzip
\t${proxy}
}
`.trim();
      })
      .join("\n");
    const publicAppIds = new Set(normalized.allowedApps);
    const cloudEmailAppBlocks = Object.keys(normalized.cloudEmailAccess)
      .filter((appId) => !publicAppIds.has(appId))
      .map((appId) => {
        const appIdSegment = encodeURIComponent(appId);
        return `
handle /api/apps/${appIdSegment}/manifest {
\t${proxy}
}
handle /api/apps/${appIdSegment} {
${indent(forwardAuth, 1)}
\t${proxy}
}
handle /api/apps/${appIdSegment}/* {
${indent(forwardAuth, 1)}
\t${proxy}
}
handle /api/app-api/${appIdSegment} {
${indent(forwardAuth, 1)}
\t${proxy}
}
handle /api/app-api/${appIdSegment}/* {
${indent(forwardAuth, 1)}
\t${proxy}
}
handle /app-assets/${appIdSegment}/* {
${indent(forwardAuth, 1)}
\t${proxy}
}
handle ${getEmbeddedAppHref(appId)} {
\tencode zstd gzip
\t${proxy}
}
handle ${getEmbeddedAppHref(appId)}/* {
\tencode zstd gzip
\t${proxy}
}
handle ${getFullAppHref(appId)} {
\tencode zstd gzip
\t${proxy}
}
handle ${getFullAppHref(appId)}/* {
\tencode zstd gzip
\t${proxy}
}
`.trim();
      })
      .join("\n");
    body = `
root * ${webRoot}
@publicApi path /api/auth/visitor /api/auth/visitor/* /api/health /api/health/* /api/tailnet /api/tailnet/*
handle @publicApi {
\t${proxy}
}
handle /app-og/* {
\t${proxy}
}
${runtimeConfigHandle}
${publicAppBlocks}
${cloudEmailAppBlocks}
@spaAssets {
\tpath /static/* /assets/* /icon.svg /favicon.ico
\t# Caddy 2.6 needs an explicit candidate; a bare file matcher can match the root.
\tfile {path}
}
handle @spaAssets {
\tencode zstd gzip
\theader Cache-Control "public, max-age=31536000, immutable"
\tfile_server
}
@missingSpaAssets path /static/* /assets/* /icon.svg /favicon.ico
handle @missingSpaAssets {
\trespond 404
}
handle {
\t@api path /api/*
\theader @api Content-Type application/json
\trespond @api \`{"error":"not_public","message":"This API route is not publicly accessible."}\` 403
\troot * /etc/caddy/static
\trewrite * /gateway.html
\tencode zstd gzip
\theader Cache-Control no-cache
\tfile_server
}
`.trim();
  }

  return `# Auto-generated by Rome — do not edit manually.
:8080 {
${indent(body, 1)}
}
`;
}
