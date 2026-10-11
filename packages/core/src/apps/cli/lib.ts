/**
 * Shared helpers for the app lifecycle CLI commands.
 *
 * The install/uninstall paths require a running daemon — they POST/DELETE to
 * the internal HTTP API which routes through AppManager. Without the daemon
 * we'd be writing to a lockfile that the live AppManager has cached in
 * memory; the daemon's per-app + lockfile mutexes are the only safe writer.
 *
 * The CLI is a thin adaptor: it resolves paths against the invoker's cwd (the
 * one thing only the CLI can do) and forwards the request. The daemon's
 * install gate owns source validation, appId derivation, and the corrective
 * error messages — daemon errors pass through verbatim.
 */
import { resolve as resolvePath } from "node:path";
import { getInternalApiBaseUrl } from "../../internal-api-url.js";
import { assertValidAppId } from "@rome-os/app-runtime/packaging";

/**
 * pnpm sets INIT_CWD to the directory the user invoked the script from,
 * before pnpm cd'd into the package. Resolve relative paths against that
 * so `pnpm app:install --source ./my-app` works from the repo root.
 */
export function resolveFromInvokerCwd(path: string): string {
  const initCwd = process.env.INIT_CWD ?? process.cwd();
  return resolvePath(initCwd, path);
}

/** Wire shape of a local or app-store install source for `POST /api/apps`. */
export type CliInstallSource =
  | { mode: "source" | "bundle"; path: string }
  | { mode: "appstore"; listingId: string; version: string };

async function installViaDaemon(body: {
  source: CliInstallSource;
  enabled: boolean;
}): Promise<{ appId: string }> {
  const url = new URL("/api/apps", getInternalApiBaseUrl());
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new Error(
      `Could not reach the daemon at ${url.toString()}: ` +
        (err instanceof Error ? err.message : String(err)) +
        ". Start Rome (pnpm start) before running this command.",
    );
  }
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`install failed: HTTP ${response.status}${text ? ` — ${text}` : ""}`);
  }
  const result = (await response.json().catch(() => null)) as {
    appId?: string;
    phase?: string;
    error?: string;
  } | null;
  if (result?.phase === "failed") {
    throw new Error(`install failed: ${result.error ?? "unknown error (phase=failed)"}`);
  }
  if (typeof result?.appId !== "string") {
    throw new Error("install failed: daemon response is missing appId");
  }
  return { appId: result.appId };
}

/**
 * Install from a local path (`source` workspace or packed `bundle`). The CLI
 * only resolves the path to an absolute one — the daemon's install gate owns
 * mode/shape validation, derives the appId from the manifest, and answers a
 * wrong path with the exact next command.
 */
export async function installLocal(
  mode: "source" | "bundle",
  path: string,
  enabled: boolean,
): Promise<{ appId: string; sourcePath: string }> {
  const absPath = resolveFromInvokerCwd(path);
  const { appId } = await installViaDaemon({ source: { mode, path: absPath }, enabled });
  return { appId, sourcePath: absPath };
}

/**
 * Install from the Rome App Store. `spec` is `<listingId>@<version>` —
 * `xiaohongshu@1.2.0` or `@handle/slug@1.2.0` (the version is everything
 * after the last `@`). The daemon retains the canonical listing id as the app
 * id and cross-checks it against the downloaded bundle's manifest.
 */
export async function installAppstore(
  spec: string,
  enabled: boolean,
): Promise<{ appId: string; listingId: string; version: string }> {
  const at = spec.lastIndexOf("@");
  if (at <= 0) {
    throw new Error(
      `--appstore expects <listingId>@<version> (e.g. xiaohongshu@1.2.0 or ` +
        `@handle/slug@1.2.0); got "${spec}"`,
    );
  }
  const listingId = spec.slice(0, at);
  const version = spec.slice(at + 1);
  if (version.length === 0) {
    throw new Error(`--appstore is missing a version after "@": "${spec}"`);
  }
  const { appId } = await installViaDaemon({
    source: { mode: "appstore", listingId, version },
    enabled,
  });
  return { appId, listingId, version };
}

export interface UninstallOptions {
  /** When true, also delete the per-app data dir + DB tables. */
  purge?: boolean;
}

export async function uninstall(
  appId: string,
  options: UninstallOptions = {},
): Promise<{ appId: string; purged: boolean }> {
  if (appId === "system") {
    throw new Error('App "system" cannot be uninstalled');
  }
  assertValidAppId(appId);
  const url = new URL(`/api/apps/${encodeURIComponent(appId)}`, getInternalApiBaseUrl());
  let response: Response;
  try {
    response = await fetch(url, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ purge: options.purge ?? false }),
    });
  } catch (err) {
    throw new Error(
      `Could not reach the daemon at ${url.toString()}: ` +
        (err instanceof Error ? err.message : String(err)),
    );
  }
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`uninstall failed: HTTP ${response.status}${text ? ` — ${text}` : ""}`);
  }
  const body = (await response.json()) as { appId: string; purged: boolean };
  return { appId: body.appId, purged: body.purged };
}
