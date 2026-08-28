import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { generateCaddyfile, resolveWebRoot } from "./caddyfile-generator.js";
import type { PublicAccessConfig } from "./public-access-config.js";

const openConfig: PublicAccessConfig = {
  enableAccessControl: false,
  allowedApps: [],
  cloudEmailAccess: {},
};

const publicConfig: PublicAccessConfig = {
  enableAccessControl: true,
  allowedApps: ["morning-brief"],
  cloudEmailAccess: {},
};

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
// no-cache, since its content changes across container boots — in EVERY
// generated Caddyfile variant.
describe("generateCaddyfile runtime-config.js delivery", () => {
  it("keeps a scoped public app id in one encoded path segment", () => {
    const caddyfile = generateCaddyfile({
      enableAccessControl: true,
      allowedApps: ["@foo/bar"],
      cloudEmailAccess: {},
    });
    expect(caddyfile).toContain("handle /apps/%40foo%2Fbar {");
    expect(caddyfile).toContain("handle /api/apps/%40foo%2Fbar/* {");
    expect(caddyfile).toContain("handle /api/app-api/%40foo%2Fbar/* {");
    expect(caddyfile).toContain("handle /app-assets/%40foo%2Fbar/* {");
  });

  it("serves /runtime-config.js as a file with no-cache in open mode", () => {
    const caddyfile = generateCaddyfile(openConfig);
    expect(caddyfile).toContain(RUNTIME_CONFIG_HANDLE);
    const handleBody = caddyfile.split(RUNTIME_CONFIG_HANDLE)[1].split("}")[0];
    expect(handleBody).toContain('header Cache-Control "no-cache"');
    expect(handleBody).toContain("file_server");
    expect(handleBody).not.toContain("max-age");
  });

  it("serves /runtime-config.js from the web root before the gateway rewrite in public-access mode", () => {
    const caddyfile = generateCaddyfile(publicConfig);
    const handleAt = caddyfile.indexOf(RUNTIME_CONFIG_HANDLE);
    const gatewayRewriteAt = caddyfile.indexOf("rewrite * /gateway.html");
    expect(handleAt).toBeGreaterThan(-1);
    expect(gatewayRewriteAt).toBeGreaterThan(-1);
    // Caddy evaluates handle blocks in config order; if the fallback gateway
    // rewrite came first, the shell's <script src="/runtime-config.js"> would
    // receive gateway HTML instead of JS on the public edge.
    expect(handleAt).toBeLessThan(gatewayRewriteAt);
  });

  it("serves the shell and runtime config from the same resolved web root", () => {
    process.env.INTERNAL_API_WEB_ROOT = "/custom/web/dist";
    const caddyfile = generateCaddyfile(openConfig);
    // The boot script writes runtime-config.js into resolveWebRoot(); the
    // Caddyfile must serve from the identical root or the browser gets the
    // build's empty stub instead of the boot-written config.
    expect(resolveWebRoot()).toBe("/custom/web/dist");
    expect(caddyfile).toContain("root * /custom/web/dist");
  });
});
