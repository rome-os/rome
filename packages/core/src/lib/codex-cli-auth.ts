// Codex authentication status reader. Agent model: docs/concepts/agents.md.
//
// Login, live account reads, and logout are driven through the process-global
// SharedCodexAccountService on Rome's shared `codex app-server`. The Codex
// binary still writes `~/.codex/auth.json`; Rome reads it only for token-profile
// metadata and the request-time revoked-token marker fallback.
//
// auth.json schema (as of 2026-05):
//   {
//     auth_mode: "chatgpt" | "apikey",
//     OPENAI_API_KEY: string | null,
//     tokens: { access_token, refresh_token, id_token, account_id },
//     last_refresh: string,
//   }
//
// Revoked-credential signal: the codex binary owns token refresh, so a revoked
// refresh token only surfaces at request time (see `codex-auth-revoked.ts`),
// never from reading auth.json — the file still looks "logged in". When a turn
// fails that way we drop a Rome-owned marker (`.rome-auth-revoked.json`) next to
// auth.json recording a fingerprint of the dead refresh token; this reader then
// downgrades the status to `needsReauth` for as long as that exact token is
// still in auth.json, and self-clears once a re-login rotates it.

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createLogger } from "../logger.js";

const log = createLogger("codex-cli-auth");

const CODEX_DIR = join(homedir(), ".codex");
const CODEX_AUTH_PATH = join(CODEX_DIR, "auth.json");
const CODEX_AUTH_REVOKED_MARKER_PATH = join(CODEX_DIR, ".rome-auth-revoked.json");

interface CodexAuthRevokedMarker {
  /** SHA-256 (hex) of the refresh token that was revoked, captured at mark time. */
  revokedRefreshTokenHash: string;
  detectedAt: string;
}

function hashToken(token: string | undefined): string {
  return createHash("sha256")
    .update(token ?? "")
    .digest("hex");
}

interface CodexAuthFile {
  auth_mode?: "chatgpt" | "apikey" | null;
  OPENAI_API_KEY?: string | null;
  tokens?: {
    access_token?: string;
    refresh_token?: string;
    id_token?: string;
    account_id?: string;
  };
  last_refresh?: string;
}

export type CodexPlanType =
  | "free"
  | "go"
  | "plus"
  | "pro"
  | "prolite"
  | "team"
  | "self_serve_business_usage_based"
  | "business"
  | "enterprise_cbp_usage_based"
  | "enterprise"
  | "edu"
  | "unknown";

export interface CodexCliStatus {
  loggedIn: boolean;
  authMode: "chatgpt" | "apikey" | null;
  planType?: CodexPlanType;
  accountType?: string;
  email?: string;
  /**
   * The stored credentials still look present, but a request has proven the
   * refresh token is revoked server-side — the guardian must log out and back
   * in. Mutually exclusive with `loggedIn` (revoked → loggedIn is false).
   */
  needsReauth?: boolean;
}

export async function getCodexCliStatus(): Promise<CodexCliStatus> {
  const file = await readAuthFile();
  if (!file) {
    await clearCodexAuthRevokedMarker();
    return { loggedIn: false, authMode: null };
  }
  if (file.auth_mode === "apikey" && file.OPENAI_API_KEY) {
    await clearCodexAuthRevokedMarker();
    return { loggedIn: true, authMode: "apikey", accountType: "api_key" };
  }
  if (file.auth_mode === "chatgpt" && file.tokens?.access_token) {
    const profile = parseCodexIdToken(file.tokens.id_token);
    // A revoked-credential marker only stands while it still fingerprints the
    // CURRENT refresh token; a re-login rotates the token and self-clears it.
    if (await isRefreshTokenRevoked(file.tokens.refresh_token)) {
      return {
        loggedIn: false,
        needsReauth: true,
        authMode: "chatgpt",
        planType: profile.planType,
        accountType: profile.accountType ?? "chatgpt",
        email: profile.email,
      };
    }
    return {
      loggedIn: true,
      authMode: "chatgpt",
      planType: profile.planType,
      accountType: profile.accountType ?? "chatgpt",
      email: profile.email,
    };
  }
  await clearCodexAuthRevokedMarker();
  return { loggedIn: false, authMode: file.auth_mode ?? null };
}

/**
 * Record that the current Codex refresh token was rejected as revoked, so the
 * settings status reader can downgrade the badge to "needs re-login" until a
 * re-login rotates the token. Fingerprinted against the token in auth.json at
 * call time; best-effort (a failure to persist just means the badge stays green).
 */
export async function markCodexAuthRevoked(): Promise<void> {
  const file = await readAuthFile();
  const refreshToken = file?.tokens?.refresh_token;
  // No chatgpt refresh token to fingerprint (apikey mode, or already logged
  // out) → nothing for the marker to pin to; drop any stale marker instead.
  if (!refreshToken) {
    await clearCodexAuthRevokedMarker();
    return;
  }
  const marker: CodexAuthRevokedMarker = {
    revokedRefreshTokenHash: hashToken(refreshToken),
    detectedAt: new Date().toISOString(),
  };
  try {
    await fs.writeFile(CODEX_AUTH_REVOKED_MARKER_PATH, JSON.stringify(marker), "utf8");
  } catch (err) {
    log.warn("failed to write codex auth-revoked marker", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Whether `refreshToken` matches a recorded revocation marker. A mismatch (or no
 * marker) means the token is current/unrevoked; a mismatch also clears
 * the now-stale marker so a re-logged-in account reads as healthy.
 */
async function isRefreshTokenRevoked(refreshToken: string | undefined): Promise<boolean> {
  const marker = await readRevokedMarker();
  if (!marker) return false;
  if (refreshToken && marker.revokedRefreshTokenHash === hashToken(refreshToken)) {
    return true;
  }
  await clearCodexAuthRevokedMarker();
  return false;
}

async function readRevokedMarker(): Promise<CodexAuthRevokedMarker | null> {
  try {
    const raw = await fs.readFile(CODEX_AUTH_REVOKED_MARKER_PATH, "utf8");
    const parsed = JSON.parse(raw) as CodexAuthRevokedMarker;
    return typeof parsed?.revokedRefreshTokenHash === "string" ? parsed : null;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") return null;
    log.warn("failed to read codex auth-revoked marker", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

async function clearCodexAuthRevokedMarker(): Promise<void> {
  try {
    await fs.unlink(CODEX_AUTH_REVOKED_MARKER_PATH);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== "ENOENT") {
      log.warn("failed to clear codex auth-revoked marker", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

interface CodexIdTokenProfile {
  planType?: CodexPlanType;
  accountType?: string;
  email?: string;
}

function normalizeCodexPlanType(value: string): CodexPlanType {
  switch (value.toLowerCase()) {
    case "free":
    case "go":
    case "plus":
    case "pro":
    case "prolite":
    case "team":
    case "self_serve_business_usage_based":
    case "business":
    case "enterprise_cbp_usage_based":
    case "enterprise":
    case "edu":
      return value.toLowerCase() as CodexPlanType;
    case "hc":
      return "enterprise";
    case "education":
      return "edu";
    default:
      return "unknown";
  }
}

function parseCodexIdToken(idToken: string | undefined): CodexIdTokenProfile {
  if (!idToken) return {};
  try {
    const [, encodedPayload] = idToken.split(".");
    if (!encodedPayload) return {};
    const payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")) as {
      email?: unknown;
      "https://api.openai.com/auth"?: {
        chatgpt_plan_type?: unknown;
      };
    };
    const rawPlanType = payload["https://api.openai.com/auth"]?.chatgpt_plan_type;
    return {
      email: typeof payload.email === "string" ? payload.email : undefined,
      planType: typeof rawPlanType === "string" ? normalizeCodexPlanType(rawPlanType) : undefined,
      accountType: typeof rawPlanType === "string" ? rawPlanType : undefined,
    };
  } catch (err) {
    log.warn("failed to parse codex id_token", {
      error: err instanceof Error ? err.message : String(err),
    });
    return {};
  }
}

async function readAuthFile(): Promise<CodexAuthFile | null> {
  try {
    const raw = await fs.readFile(CODEX_AUTH_PATH, "utf8");
    return JSON.parse(raw) as CodexAuthFile;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") return null;
    log.warn("failed to read codex auth.json", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
