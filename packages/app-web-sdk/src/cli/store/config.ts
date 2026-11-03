import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

// Config is kept small on purpose: host, token, and the email we logged in as
// (for display only). One config file means one logged-in account at a time.
export interface CliConfig {
  host: string;
  email: string;
  token: string;
}

export const DEFAULT_HOST = "https://romeos.cc";

function configDir(): string {
  return process.env.ROME_STORE_CONFIG_DIR || path.join(os.homedir(), ".rome");
}

function configPath(): string {
  return path.join(configDir(), "store-token.json");
}

export async function loadConfig(): Promise<CliConfig | null> {
  try {
    const raw = await fs.readFile(configPath(), "utf8");
    const parsed = JSON.parse(raw);
    if (
      typeof parsed?.host === "string" &&
      typeof parsed?.email === "string" &&
      typeof parsed?.token === "string"
    ) {
      return parsed as CliConfig;
    }
    return null;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export async function saveConfig(config: CliConfig): Promise<string> {
  const dir = configDir();
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const file = configPath();
  await fs.writeFile(file, JSON.stringify(config, null, 2), { mode: 0o600 });
  return file;
}

// Resolved bearer for outbound API calls. Tracks whether we got the token
// from ROME_TOKEN (env) or from the on-disk login config, so commands can
// pick the right host/email and surface the auth source in `whoami`.
export interface CliBearer {
  token: string;
  source: "env" | "config";
  host: string;
  email?: string;
}

export async function resolveBearer(): Promise<CliBearer | null> {
  const env = process.env.ROME_TOKEN;
  if (env && env.trim().length > 0) {
    const hostEnv = process.env.ROME_STORE_HOST?.trim();
    return {
      token: env.trim(),
      source: "env",
      host: hostEnv && hostEnv.length > 0 ? hostEnv : DEFAULT_HOST,
    };
  }
  const cfg = await loadConfig();
  if (cfg) {
    return { token: cfg.token, source: "config", host: cfg.host, email: cfg.email };
  }
  return null;
}

export async function requireBearer(): Promise<CliBearer> {
  const bearer = await resolveBearer();
  if (!bearer) {
    throw new CliError(
      `Not logged in. Either set ROME_TOKEN (generate one in Settings → CLI / API token) or run "rome login --host <URL>".`,
    );
  }
  return bearer;
}

export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode: number = 1,
  ) {
    super(message);
    this.name = "CliError";
  }
}
