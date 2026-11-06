#!/usr/bin/env tsx
/**
 * Container-boot Caddyfile generator. Runs from scripts/docker/rome-init.sh
 * before Caddy starts, when the daemon isn't up yet.
 *
 * Uses the canonical pure generator in `packages/core/src/lib/`.
 */

import { join, dirname } from "node:path";
import { writeFileSync, mkdirSync } from "node:fs";

import { generateCaddyfile, resolveWebRoot } from "../packages/core/src/lib/caddyfile-generator.js";
import {
  RUNTIME_CONFIG_FILENAME,
  buildRuntimeConfigJs,
} from "../packages/core/src/lib/runtime-config.js";

const CADDY_PATH = process.env.CADDY_CONFIG_PATH || "/etc/caddy/Caddyfile";

try {
  mkdirSync(dirname(CADDY_PATH), { recursive: true });
  writeFileSync(CADDY_PATH, generateCaddyfile(), "utf-8");
  console.log(`Caddyfile written to ${CADDY_PATH}`);
} catch (err) {
  console.error("Failed to write Caddyfile:", err);
  process.exit(1);
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
