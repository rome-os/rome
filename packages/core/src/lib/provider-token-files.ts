import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  OAuthProviderGrantProfile,
  ShopifyGrantProfile,
  SlackGrantProfile,
} from "../connections/integrations/oauth-providers.js";
import type { SecretRecord } from "../connections/types.js";
import { createLogger } from "../logger.js";
import type { OAuthProvider } from "./oauth-providers.js";

const log = createLogger("provider-token-files");

/**
 * The single runtime owner of on-disk provider OAuth token files.
 *
 * Some provider credentials must be shared with a consumer that can't read
 * core's grant ledger — either an out-of-process tool (the in-container shell
 * `gh`/`git` wrappers) or a sandboxed app (the `connector` reading them for
 * `connector_proxy`). The sanctioned channel for that is a file on the shared
 * `/run/rome` tmpfs, and its contents are a pure function of grant state: the
 * connection registry's custody hook drives `syncProviderTokenFile` /
 * `clearProviderTokenFile` off grant transitions, so the atomic-write discipline
 * and the on-disk shape both live in exactly one place.
 *
 * The write is driven by the grant's own shape: the secret `material`
 * (`SecretRecord`) plus the non-secret service-owned profile — the Slack
 * file needs `SlackGrantProfile.teamId`, which is profile, not material.
 */

const DEFAULT_TOKEN_DIR = "/run/rome";

// `${path}.<pid>.<n>.tmp` — unique per process and per call so two concurrent
// writers (or a stale temp from a prior crash) can never collide on one path.
let tempCounter = 0;

/**
 * Resolve a provider's token-file path. The default is
 * `/run/rome/<provider>-oauth-token`; an env override `ROME_<PROVIDER>_TOKEN_FILE`
 * redirects it (used in tests, and shared with the connector/shell which read the
 * same `ROME_GITHUB_TOKEN_FILE` override).
 */
export function getProviderTokenFilePath(provider: OAuthProvider): string {
  const override = process.env[`ROME_${provider.toUpperCase()}_TOKEN_FILE`]?.trim();
  return override || `${DEFAULT_TOKEN_DIR}/${provider}-oauth-token`;
}

/**
 * Render a provider's grant material + profile to its on-disk contents, or `null`
 * when there is no usable credential (→ the file is cleared) or the provider
 * shares no file. The trailing newline keeps the `github` line byte-compatible
 * with what the shell wrapper and connector already strip on read.
 *
 * On-disk shape per provider:
 * - `github`: a single bare access-token line (`material.accessToken`).
 * - `slack`: a JSON object `{ botToken, userToken, teamId }` — the bot/user
 *   tokens are secret (`material.botToken` / `material.userToken`); `teamId` is
 *   workspace identity and rides in `profile.teamId`.
 * - `shopify`: a JSON object `{ accessToken, shop }` — the hourly access token
 *   (`material.accessToken`, rewritten on each refresh) and the store's
 *   `.myshopify.com` domain, the Admin API host (`profile.login`). No file
 *   without both: a token alone can't say which store it opens.
 * - any other provider (e.g. `google`): no file consumer today → `null`.
 */
function serializeProviderTokenFile(
  provider: OAuthProvider,
  material: SecretRecord,
  profile: OAuthProviderGrantProfile,
): string | null {
  switch (provider) {
    case "github": {
      const accessToken = material.accessToken?.trim();
      return accessToken ? `${accessToken}\n` : null;
    }
    case "slack": {
      const botToken = material.botToken?.trim();
      if (!botToken) return null;
      const userToken = material.userToken ?? null;
      const teamId = (profile as SlackGrantProfile).teamId ?? null;
      return `${JSON.stringify({ botToken, userToken, teamId })}\n`;
    }
    case "shopify": {
      const accessToken = material.accessToken?.trim();
      const shop = (profile as ShopifyGrantProfile).login;
      if (!accessToken || !shop) return null;
      return `${JSON.stringify({ accessToken, shop })}\n`;
    }
    default:
      return null;
  }
}

async function writeFileAtomic(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o770 });
  // Write to a unique temp sibling then rename, so a concurrent reader (the shell
  // wrapper reads the file fresh per `gh`/`git` call) never catches a partial or
  // empty file mid-update.
  const tmp = `${path}.${process.pid}.${++tempCounter}.tmp`;
  try {
    await writeFile(tmp, contents, { mode: 0o640 });
    await chmod(tmp, 0o640);
    await rename(tmp, path);
  } catch (error) {
    // Never leave token contents at the predictable temp path if chmod/rename
    // fails partway. Best-effort unlink; surface the original failure.
    await unlink(tmp).catch(() => {});
    throw error;
  }
}

async function unlinkIfPresent(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

/**
 * Write (or, when the material carries no usable credential, clear) a provider's
 * on-disk token file. The single write path for every provider's token file.
 */
export async function syncProviderTokenFile(
  provider: OAuthProvider,
  material: SecretRecord,
  profile: OAuthProviderGrantProfile,
): Promise<void> {
  const path = getProviderTokenFilePath(provider);
  const contents = serializeProviderTokenFile(provider, material, profile);
  if (contents === null) {
    await unlinkIfPresent(path);
    return;
  }
  await writeFileAtomic(path, contents);
  log.debug("wrote provider token file", { provider });
}

/** Remove a provider's on-disk token file (disconnect). Missing file is fine. */
export async function clearProviderTokenFile(provider: OAuthProvider): Promise<void> {
  await unlinkIfPresent(getProviderTokenFilePath(provider));
}

/**
 * Read the GitHub access token from its on-disk token file — the custody
 * artifact the out-of-process consumers (shell `gh`/`git`, `connector_proxy`)
 * also read. The file is a bare access-token line, returned trimmed.
 *
 * An absent file (ENOENT) → `null`: the grant is not connected, degraded, or
 * pre-boot, and the caller treats it as "no token" and fails cleanly. An empty
 * file → `null` for the same reason. Any other read error (permission, I/O) is a
 * real fault and surfaces. Honors the `ROME_GITHUB_TOKEN_FILE` override via
 * `getProviderTokenFilePath`.
 */
export async function readGithubAccessTokenFile(): Promise<string | null> {
  let contents: string;
  try {
    contents = await readFile(getProviderTokenFilePath("github"), "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  return contents.trim() || null;
}
