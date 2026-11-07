import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { generateCaddyfile, resolveWebRoot } from "./caddyfile-generator.js";
import { normalizePublicAccessConfig } from "./public-access-config.js";

const RUNTIME_CONFIG_HANDLE = "handle /runtime-config.js {";

let savedWebRoot: string | undefined;

beforeEach(() => {
  savedWebRoot = process.env.INTERNAL_API_WEB_ROOT;
  delete process.env.INTERNAL_API_WEB_ROOT;
});

afterEach(() => {
  if (savedWebRoot === undefined) delete process.env.INTERNAL_API_WEB_ROOT;
  else process.env.INTERNAL_API_WEB_ROOT = savedWebRoot;
});

// The C1 delivery contract: Caddy serves the SPA shell from disk, so
// the boot-written runtime-config.js must be reachable as a real file — with
// no-cache, since its content changes across container boots.
describe("generateCaddyfile runtime-config.js delivery", () => {
  it("serves /runtime-config.js as a file with no-cache", () => {
    const caddyfile = generateCaddyfile();
    expect(caddyfile).toContain(RUNTIME_CONFIG_HANDLE);
    const handleBody = caddyfile.split(RUNTIME_CONFIG_HANDLE)[1].split("}")[0];
    expect(handleBody).toContain('header Cache-Control "no-cache"');
    expect(handleBody).toContain("file_server");
    expect(handleBody).not.toContain("max-age");
  });

  it("serves the shell and runtime config from the same resolved web root", () => {
    process.env.INTERNAL_API_WEB_ROOT = "/custom/web/dist";
    const caddyfile = generateCaddyfile();
    // The boot script writes runtime-config.js into resolveWebRoot(); the
    // Caddyfile must serve from the identical root or the browser gets the
    // build's empty stub instead of the boot-written config.
    expect(resolveWebRoot()).toBe("/custom/web/dist");
    expect(caddyfile).toContain("root * /custom/web/dist");
  });
});

describe("generateCaddyfile app document routes", () => {
  it("proxies /apps and /full/apps documents to Hono, after the asset handlers", () => {
    const caddyfile = generateCaddyfile();
    expect(caddyfile).toContain("@appDocs path /apps /apps/* /full/apps /full/apps/*");
    const appDocsAt = caddyfile.indexOf("handle @appDocs {");
    const missingAssetsAt = caddyfile.indexOf("handle @missingSpaAssets {");
    const fallbackAt = caddyfile.lastIndexOf("try_files {path} /index.html");
    expect(appDocsAt).toBeGreaterThan(missingAssetsAt);
    expect(appDocsAt).toBeLessThan(fallbackAt);
    const body = caddyfile.split("handle @appDocs {")[1].split("\n\t}\n\thandle {")[0];
    expect(body).toContain("reverse_proxy 127.0.0.1:");
    expect(body).toContain("encode zstd gzip");
    expect(body).toContain("forward_auth 127.0.0.1:");
    expect(body.indexOf("forward_auth")).toBeLessThan(body.indexOf("reverse_proxy"));
  });
});

describe("app document authentication fallback", () => {
  it("serves only the public shell for denied documents, never for API denials", () => {
    const caddyfile = generateCaddyfile();
    const document = caddyfile.split("handle @appDocs {")[1];
    expect(document).toContain("@appAuthDenied status 401 403");
    expect(document).toContain("handle_response @appAuthDenied");
    expect(document).toContain("rewrite * /index.html");
    expect(document).toContain('header Cache-Control "no-cache"');
    const dynamic = caddyfile.split("handle @dynamic {")[1].split("handle /runtime-config.js")[0];
    expect(dynamic).not.toContain("appAuthDenied");
    expect(dynamic).not.toContain("file_server");
  });
});

describe("generateCaddyfile social card images", () => {
  it("proxies /app-og through the dynamic matcher", () => {
    const caddyfile = generateCaddyfile();
    expect(caddyfile).toContain(
      "@dynamic path /api /api/* /webhooks /webhooks/* /app-assets /app-assets/* /app-og /app-og/*",
    );
  });
});

describe("generateCaddyfile home-screen manifests and icons", () => {
  it("proxies them through the dynamic matcher", () => {
    const caddyfile = generateCaddyfile();
    const dynamic =
      caddyfile.split("\n").find((line) => line.trim().startsWith("@dynamic path")) ?? "";
    expect(dynamic).toContain(" /app-manifest/* /app-icon/*");
  });
});

describe("canonical path guard", () => {
  it("runs before every proxied handler", () => {
    const caddyfile = generateCaddyfile();
    const guardAt = caddyfile.indexOf("handle @nonCanonicalPath {");
    const firstProxyAt = caddyfile.indexOf("reverse_proxy");
    expect(guardAt).toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(firstProxyAt);
  });

  it("leaves an encoded slash allowed for scoped app ids", () => {
    const caddyfile = generateCaddyfile();
    const expression =
      caddyfile.split("\n").find((line) => line.trim().startsWith("expression")) ?? "";
    expect(expression).toContain("%2[eE]");
    expect(expression).not.toMatch(/%2\[[^\]]*[fF]/);
  });
});

// A policy persisted by an earlier release can still carry the retired
// `enableAccessControl` flag. It is dropped on read and never changes the proxy:
// the dashboard and login stay reachable, and per-app sharing is decided per
// request by the `/api/auth/verify` probe behind `forward_auth`.
describe("generateCaddyfile with a persisted legacy enableAccessControl flag", () => {
  const persisted = {
    enableAccessControl: true,
    allowedApps: ["morning-brief"],
    cloudEmailAccess: { "night-brief": ["a@b.co"] },
  };

  it("normalizes without the flag and keeps the app policy", () => {
    const config = normalizePublicAccessConfig(persisted);
    expect(config).toEqual({
      allowedApps: ["morning-brief"],
      cloudEmailAccess: { "night-brief": ["a@b.co"] },
    });
    expect("enableAccessControl" in config).toBe(false);
  });

  it("still produces the normal dashboard-reachable Caddyfile", () => {
    const caddyfile = generateCaddyfile();
    expect(caddyfile).toContain("forward_auth 127.0.0.1:4141 {");
    expect(caddyfile).toContain("uri /api/auth/verify");
    // Login and the rest of /api/* go through the gate, not a canned 403.
    expect(caddyfile).toContain("@dynamic path /api /api/*");
    expect(caddyfile).not.toContain("not_public");
    expect(caddyfile).not.toContain("gateway");
    expect(caddyfile).toContain("try_files {path} /index.html");
  });
});
