#!/usr/bin/env tsx
/**
 * Container-boot Caddyfile + gateway-page generator. Runs from
 * scripts/docker/rome-init.sh before Caddy starts, when the daemon isn't up yet.
 *
 * Uses the canonical pure generators in `packages/core/src/lib/` so the
 * output is identical to what the runtime regenerator emits when the
 * publicAccess setting changes via API.
 */

import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import Database from "better-sqlite3";

import { generateCaddyfile, resolveWebRoot } from "../packages/core/src/lib/caddyfile-generator.js";
import { buildGatewayHtml } from "../packages/core/src/lib/gateway-html.js";
import {
  RUNTIME_CONFIG_FILENAME,
  buildRuntimeConfigJs,
} from "../packages/core/src/lib/runtime-config.js";
import {
  DEFAULT_PUBLIC_ACCESS_CONFIG,
  PUBLIC_ACCESS_SETTING_KEY,
  normalizePublicAccessConfig,
  type PublicAccessConfig,
} from "../packages/core/src/lib/public-access-config.js";

const SQLITE_PATH =
  process.env.SQLITE_PATH ??
  join(homedir(), ".rome", process.env.ROME_PROFILE || "default", "rome.db");
const CADDY_PATH = process.env.CADDY_CONFIG_PATH || "/etc/caddy/Caddyfile";
const GATEWAY_DIR = "/etc/caddy/static";

function readPublicAccessConfig(): PublicAccessConfig {
  try {
    const sqlite = new Database(SQLITE_PATH, { readonly: true });
    const row = sqlite
      .prepare("SELECT value FROM settings WHERE key = ?")
      .get(PUBLIC_ACCESS_SETTING_KEY) as { value: string } | undefined;
    sqlite.close();

    if (row) {
      const parsed = typeof row.value === "string" ? JSON.parse(row.value) : row.value;
      return normalizePublicAccessConfig(parsed);
    }
  } catch {
    // DB may not exist yet on first boot.
  }
  return DEFAULT_PUBLIC_ACCESS_CONFIG;
}

function detectTailnetDns(): string | null {
  try {
    const stdout = execFileSync("tailscale", ["status", "--json"], {
      timeout: 5000,
      encoding: "utf-8",
    });
    const status = JSON.parse(stdout);
    return status.Self?.DNSName?.replace(/\.$/, "") || null;
  } catch {
    return null;
  }
}

// Sync sibling of `lib/gateway-page.ts:getInstanceName` — the runtime path
// uses async Drizzle, but at boot time we only have a raw sqlite handle.
function getInstanceName(): string {
  try {
    const sqlite = new Database(SQLITE_PATH, { readonly: true });
    const row = sqlite
      .prepare("SELECT display_name FROM persons WHERE bond_level = ? LIMIT 1")
      .get("guardian") as { display_name: string } | undefined;
    sqlite.close();
    if (row?.display_name) return row.display_name;
  } catch {
    // DB may not exist
  }

  if (process.env.PANTHEON_SLUG) return process.env.PANTHEON_SLUG;

  const tailnetDns = detectTailnetDns();
  if (tailnetDns) return tailnetDns.split(".")[0];

  return "This";
}

const config = readPublicAccessConfig();
const caddyfile = generateCaddyfile(config);

try {
  mkdirSync(dirname(CADDY_PATH), { recursive: true });
  writeFileSync(CADDY_PATH, caddyfile, "utf-8");
  console.log(
    `Caddyfile written to ${CADDY_PATH} (enableAccessControl=${config.enableAccessControl}, apps=${config.allowedApps.join(",")})`,
  );
} catch (err) {
  console.error("Failed to write Caddyfile:", err);
  process.exit(1);
}

try {
  const instanceName = getInstanceName();
  const html = buildGatewayHtml({
    publicAccessConfig: config,
    instanceName,
    romeCloudSlug: process.env.PANTHEON_SLUG || null,
    romeCloudDomain: process.env.PANTHEON_DOMAIN || null,
    gaMeasurementId: process.env.ROME_GA_MEASUREMENT_ID || null,
  });
  mkdirSync(GATEWAY_DIR, { recursive: true });
  writeFileSync(`${GATEWAY_DIR}/gateway.html`, html, "utf-8");
  console.log(`Gateway page generated at ${GATEWAY_DIR}/gateway.html`);
} catch (err) {
  console.error("Warning: Failed to generate gateway page:", err);
}

// Runtime browser config is written into the same
// web root Caddy's file_server serves the shell from — serve-time injection in
// Hono never reaches production, so the config must exist on disk. Overwrites
// the build's empty stub (packages/web/public/runtime-config.js) every boot,
// so changing/emptying ROME_GA_MEASUREMENT_ID needs no rebuild.
try {
  const runtimeConfigPath = join(resolveWebRoot(), RUNTIME_CONFIG_FILENAME);
  writeFileSync(
    runtimeConfigPath,
    buildRuntimeConfigJs({ gaMeasurementId: process.env.ROME_GA_MEASUREMENT_ID || null }),
    "utf-8",
  );
  console.log(`Runtime config written to ${runtimeConfigPath}`);
} catch (err) {
  console.error("Warning: Failed to write SPA runtime config:", err);
}
