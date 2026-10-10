import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  getAnthropicCompatibleCredentialSecret,
  getStoredAnthropicCompatibleCredentials,
} from "./anthropic-compatible-providers.js";
import {
  isAnthropicCompatibleConfigurationId,
  type AnthropicCompatibleConfigurationId,
  type StoredAnthropicCompatibleCredentials,
} from "@rome/api-types/anthropic-compatible-providers";
import { createLogger } from "../logger.js";
import type { SettingsRepository } from "../db/repositories/settings.js";

const log = createLogger("anthropic-login");

//
// The Claude binary owns token refresh, so a revoked/expired credential only
// surfaces at request time (a 401, see `anthropic-auth-revoked.ts`), never from
// `claude auth status` — which keeps reporting "logged in". When a turn fails
// that way we drop a Rome-owned marker recording a fingerprint of the OAuth
// credentials file; the settings reader then downgrades the badge to
// `needsReauth`. The marker self-clears when a re-login rewrites the file (the
// fingerprint changes) and the provider clears it after any turn that succeeds.
//
// On the canonical Linux runtime the OAuth session lives in
// `~/.claude/.credentials.json`. On a macOS host it lives in the Keychain
// instead (no file): the fingerprint is then null and the marker can only be
// cleared by a successful turn or an explicit logout — acceptable for that
// non-containerized dev path.

const CLAUDE_DIR = join(homedir(), ".claude");
const CLAUDE_CREDENTIALS_PATH = join(CLAUDE_DIR, ".credentials.json");
const ANTHROPIC_AUTH_REVOKED_MARKER_PATH = join(CLAUDE_DIR, ".rome-auth-revoked.json");

interface AnthropicAuthRevokedMarker {
  source: AnthropicAuthRevokedSource;
  detectedAt: string;
}

export type AnthropicAuthRevokedSource =
  | {
      type: "claude-cli";
      /**
       * SHA-256 (hex) of the OAuth credentials file at mark time, or null when
       * the file is unreadable (Keychain-backed macOS host). A non-null
       * fingerprint lets the marker self-clear once a re-login rewrites the
       * file.
       */
      credentialFingerprint: string | null;
    }
  | {
      type: "stored-compatible";
      provider: AnthropicCompatibleConfigurationId;
      apiKeyHash: string;
    };

function hashCredential(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function fingerprintClaudeCredentials(): Promise<string | null> {
  try {
    const raw = await fs.readFile(CLAUDE_CREDENTIALS_PATH);
    return createHash("sha256").update(raw).digest("hex");
  } catch {
    return null;
  }
}

export function buildStoredAnthropicCompatibleRevokedSource(
  credentials: StoredAnthropicCompatibleCredentials,
): AnthropicAuthRevokedSource {
  return {
    type: "stored-compatible",
    provider: credentials.provider,
    apiKeyHash: hashCredential(getAnthropicCompatibleCredentialSecret(credentials)),
  };
}

export async function buildClaudeCliRevokedSource(): Promise<AnthropicAuthRevokedSource> {
  return {
    type: "claude-cli",
    credentialFingerprint: await fingerprintClaudeCredentials(),
  };
}

/**
 * Source eligible for a persisted Anthropic revoked marker. Stored
 * Anthropic-compatible credentials and Claude CLI OAuth can be fixed from AI
 * Tools and have stable fingerprints. Raw env API keys are intentionally not
 * persisted here: there is no settings UI that can update them, and treating
 * them as Claude would misdiagnose the active credential.
 */
export async function resolveAnthropicAuthRevokedSourceForQuery(
  credentials: StoredAnthropicCompatibleCredentials | null,
  env: NodeJS.ProcessEnv = process.env,
): Promise<AnthropicAuthRevokedSource | null> {
  if (credentials) return buildStoredAnthropicCompatibleRevokedSource(credentials);
  if (env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN) return null;
  return buildClaudeCliRevokedSource();
}

function isAnthropicAuthRevokedSource(value: unknown): value is AnthropicAuthRevokedSource {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const source = value as Record<string, unknown>;
  if (source.type === "claude-cli") {
    return (
      source.credentialFingerprint === null || typeof source.credentialFingerprint === "string"
    );
  }
  if (source.type === "stored-compatible") {
    return (
      isAnthropicCompatibleConfigurationId(source.provider) &&
      typeof source.apiKeyHash === "string" &&
      source.apiKeyHash.length > 0
    );
  }
  return false;
}

function parseAnthropicAuthRevokedMarker(value: unknown): AnthropicAuthRevokedMarker | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (isAnthropicAuthRevokedSource(record.source)) {
    return {
      source: record.source,
      detectedAt: typeof record.detectedAt === "string" ? record.detectedAt : "",
    };
  }
  // Back-compat for markers written before source scoping.
  if ("credentialFingerprint" in record) {
    const credentialFingerprint = record.credentialFingerprint;
    if (credentialFingerprint === null || typeof credentialFingerprint === "string") {
      return {
        source: {
          type: "claude-cli",
          credentialFingerprint,
        },
        detectedAt: typeof record.detectedAt === "string" ? record.detectedAt : "",
      };
    }
  }
  return null;
}

function sourcesMatch(
  marker: AnthropicAuthRevokedSource,
  current: AnthropicAuthRevokedSource,
): boolean {
  if (marker.type !== current.type) return false;
  if (marker.type === "claude-cli" && current.type === "claude-cli") {
    if (marker.credentialFingerprint === null || current.credentialFingerprint === null) {
      return marker.credentialFingerprint === current.credentialFingerprint;
    }
    return marker.credentialFingerprint === current.credentialFingerprint;
  }
  if (marker.type === "stored-compatible" && current.type === "stored-compatible") {
    return marker.provider === current.provider && marker.apiKeyHash === current.apiKeyHash;
  }
  return false;
}

/**
 * Record that the active Anthropic-side credential was rejected (401), so the
 * settings status reader can downgrade the right badge. Best-effort.
 */
export async function markAnthropicAuthRevoked(
  source?: AnthropicAuthRevokedSource | null,
): Promise<void> {
  const markerSource = source === undefined ? await buildClaudeCliRevokedSource() : source;
  if (!markerSource) return;
  const marker: AnthropicAuthRevokedMarker = {
    source: markerSource,
    detectedAt: new Date().toISOString(),
  };
  try {
    await fs.mkdir(CLAUDE_DIR, { recursive: true });
    await fs.writeFile(ANTHROPIC_AUTH_REVOKED_MARKER_PATH, JSON.stringify(marker), "utf8");
  } catch (err) {
    log.warn("failed to write anthropic auth-revoked marker", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function unlinkAnthropicAuthRevokedMarker(): Promise<void> {
  try {
    await fs.unlink(ANTHROPIC_AUTH_REVOKED_MARKER_PATH);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== "ENOENT") {
      log.warn("failed to clear anthropic auth-revoked marker", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/** Remove the revoked marker (re-login rotated the file, or a turn succeeded). */
export async function clearAnthropicAuthRevoked(
  source?: AnthropicAuthRevokedSource | null,
): Promise<void> {
  if (source === null) return;
  if (source === undefined) {
    await unlinkAnthropicAuthRevokedMarker();
    return;
  }
  const marker = await readAnthropicAuthRevokedMarker();
  if (marker && sourcesMatch(marker.source, source)) {
    await unlinkAnthropicAuthRevokedMarker();
  }
}

export async function clearClaudeAuthRevoked(): Promise<void> {
  const marker = await readAnthropicAuthRevokedMarker();
  if (!marker || marker.source.type === "claude-cli") {
    await unlinkAnthropicAuthRevokedMarker();
  }
}

export async function clearStoredAnthropicCompatibleAuthRevoked(): Promise<void> {
  const marker = await readAnthropicAuthRevokedMarker();
  if (marker?.source.type === "stored-compatible") {
    await unlinkAnthropicAuthRevokedMarker();
  }
}

async function readAnthropicAuthRevokedMarker(): Promise<AnthropicAuthRevokedMarker | null> {
  try {
    const raw = await fs.readFile(ANTHROPIC_AUTH_REVOKED_MARKER_PATH, "utf8");
    return parseAnthropicAuthRevokedMarker(JSON.parse(raw));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== "ENOENT") {
      log.warn("failed to read anthropic auth-revoked marker", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return null;
  }
}

/**
 * Whether the Claude CLI credential is currently flagged as revoked. A marker
 * with a fingerprint that no longer matches the credentials file means a
 * re-login already rotated it — that case clears the stale marker and reports
 * healthy. Used for the settings badge.
 */
export async function isAnthropicAuthRevoked(): Promise<boolean> {
  const marker = await readAnthropicAuthRevokedMarker();
  if (!marker) return false;
  if (marker.source.type !== "claude-cli") return false;
  // A null fingerprint (Keychain host) can't be compared — keep it flagged until
  // a successful turn or logout clears it.
  if (marker.source.credentialFingerprint === null) return true;
  const current = await fingerprintClaudeCredentials();
  if (current !== null && current === marker.source.credentialFingerprint) return true;
  // The file changed (re-login) — the marker is stale.
  await clearAnthropicAuthRevoked();
  return false;
}

export async function isAnthropicCompatibleAuthRevoked(
  settingsRepo?: Pick<SettingsRepository, "get">,
): Promise<boolean> {
  const marker = await readAnthropicAuthRevokedMarker();
  if (!marker || marker.source.type !== "stored-compatible") return false;
  const credentials = await getStoredAnthropicCompatibleCredentials(settingsRepo);
  if (!credentials) {
    await clearStoredAnthropicCompatibleAuthRevoked();
    return false;
  }
  const current = buildStoredAnthropicCompatibleRevokedSource(credentials);
  if (!sourcesMatch(marker.source, current)) {
    await clearStoredAnthropicCompatibleAuthRevoked();
    return false;
  }
  return true;
}
