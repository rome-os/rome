import { describe, it, expect, afterEach } from "@rstest/core";
import { generateCaddyfile } from "./caddyfile-generator.js";

describe("generateCaddyfile", () => {
  const originalPort = process.env.INTERNAL_API_PORT;

  afterEach(() => {
    if (originalPort === undefined) delete process.env.INTERNAL_API_PORT;
    else process.env.INTERNAL_API_PORT = originalPort;
  });

  it("gates only dynamic surfaces through forward_auth", () => {
    const out = generateCaddyfile();
    expect(out).toContain(":8080 {");
    expect(out).toContain("reverse_proxy 127.0.0.1:4141");
    // forward_auth lives in the @dynamic block, which only covers the
    // surfaces Hono owns (API + webhooks + app bundles).
    expect(out).toContain(
      "@dynamic path /api /api/* /webhooks /webhooks/* /app-assets /app-assets/*",
    );
    expect(out).toContain("forward_auth 127.0.0.1:4141 {");
    expect(out).toContain("uri /api/auth/verify");
    expect(out).toContain(
      "copy_headers X-Rome-User-Id X-Rome-Visitor-Account-Id X-Rome-Visitor-Email",
    );
    expect(out).not.toContain("gateway");
  });

  it("serves the SPA from disk (no Hono round-trip)", () => {
    const out = generateCaddyfile();
    // Rsbuild emits hashed JS/CSS beneath /static. Keep that path in its own
    // file-server handle so a missing chunk is a real 404 rather than the SPA
    // HTML fallback, and make successful immutable chunks cheap to revisit.
    expect(out).toContain("root * /app/packages/web/dist");
    expect(out).toContain("path /static/* /assets/* /icon.svg /favicon.ico");
    expect(out).toContain("file {path}");
    const assetsStart = out.indexOf("handle @spaAssets {");
    const assetsEnd = out.indexOf("\n\t@missingSpaAssets", assetsStart);
    const assetsBlock = out.slice(assetsStart, assetsEnd);
    expect(assetsBlock).toContain("encode zstd gzip");
    expect(assetsBlock).toContain('header Cache-Control "public, max-age=31536000, immutable"');
    expect(assetsBlock).toContain("file_server");
    expect(assetsBlock).not.toContain("try_files");
    expect(out).toContain("@missingSpaAssets path /static/* /assets/* /icon.svg /favicon.ico");
    expect(out).toContain("handle @missingSpaAssets {\n\t\trespond 404");

    // Unknown client routes still fall back to index.html, but the shell is
    // compressed and revalidated so deployments never pin stale HTML.
    expect(out).toContain("try_files {path} /index.html");
    expect(out).toContain("file_server");
    // The SPA `handle {}` fallback (the last handle block) must NOT re-auth —
    // static/shell are public, so they skip the forward_auth round-trip.
    const spaBlock = out.slice(out.lastIndexOf("handle {"));
    expect(spaBlock).toContain("encode zstd gzip");
    expect(spaBlock).toContain('header Cache-Control "no-cache"');
    expect(spaBlock).toContain("file_server");
    expect(spaBlock).not.toContain("forward_auth");
  });

  it("routes WebSocket paths around forward_auth (caddy#5430)", () => {
    const out = generateCaddyfile();
    // forward_auth forwards Upgrade/Connection headers verbatim to the
    // auth probe and stalls on WS upgrades — the WS paths must bypass it.
    expect(out).toContain("@wsUpgrade path /ws/* /desktop-proxy /desktop-proxy/*");
    // The WS handle should NOT contain forward_auth.
    const wsBlock = out.match(/handle @wsUpgrade \{[^}]+\}/)?.[0] ?? "";
    expect(wsBlock).not.toContain("forward_auth");
    expect(wsBlock).toContain("reverse_proxy");
  });

  it("lets app WebSocket upgrades through forward_auth via header_up -Connection", () => {
    const out = generateCaddyfile();
    // App WS lives under /api/apps/* and /api/app-api/*, so it stays in the
    // @dynamic block to keep the cookie gate. Stripping Connection from the
    // forward_auth probe copy only is what lets the handshake reach the app.
    const dynamicBlock = out.match(/forward_auth 127\.0\.0\.1:4141 \{[\s\S]*?\n\t\}/)?.[0] ?? "";
    expect(dynamicBlock).toContain("header_up -Connection");
  });

  it("honours INTERNAL_API_PORT for the upstream", () => {
    process.env.INTERNAL_API_PORT = "9999";
    const out = generateCaddyfile();
    expect(out).toContain("reverse_proxy 127.0.0.1:9999");
    expect(out).toContain("forward_auth 127.0.0.1:9999 {");
  });

  it("never proxies the private Discord broker", () => {
    const out = generateCaddyfile();
    expect(out).not.toContain("/_internal");
    expect(out).not.toMatch(/path[^\n]*_internal/);
  });
});
