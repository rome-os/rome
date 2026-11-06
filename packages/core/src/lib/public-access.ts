import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { generateCaddyfile } from "./caddyfile-generator.js";

const DEFAULT_CADDY_CONFIG_PATH = "/etc/caddy/Caddyfile";

function execFileAsync(command: string, args: string[], timeout: number): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout }, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

/** Rewrites the Caddyfile at startup when Rome explicitly owns a Caddy proxy. */
export async function reconcilePublicAccessAtStartup(): Promise<void> {
  // CADDY_CONFIG_PATH explicitly declares that Rome owns the proxy config.
  if (!process.env.CADDY_CONFIG_PATH) return;

  await writeCaddyfileAndReload();
}

export async function writeCaddyfileAndReload(): Promise<void> {
  const caddyPath = process.env.CADDY_CONFIG_PATH || DEFAULT_CADDY_CONFIG_PATH;

  await writeFile(caddyPath, generateCaddyfile(), "utf-8");
  await execFileAsync("caddy", ["reload", "--config", caddyPath], 10_000);
}
