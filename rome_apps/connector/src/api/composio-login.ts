import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * CLI-driven login for the Composio app. The CLI's on-disk session
 * (`~/.composio/user_data.json`) is the single source of truth for the key:
 * shelling out to the `composio` binary is the only place the app writes that
 * session, and `readSessionApiKey` is the only place the rest of the app reads
 * it. Keep both behind this module so the CLI coupling lives in one file.
 *
 * Two-step flow, because authorization happens in the guardian's browser:
 *   1. `startCliLogin` runs `composio login --no-wait` → returns the login URL
 *      + an opaque session key (`cli_key`). The guardian opens the URL and
 *      authorizes in the Composio dashboard.
 *   2. `completeCliLogin` runs `composio login --key <cli_key>`, which blocks
 *      until the session is authorized (or the timeout fires) and persists the
 *      issued key into the CLI session, then returns it.
 *
 * The caller validates the issued key (a ping) but never stores it — the CLI
 * session already holds it, and the app reads it live from there on every call.
 */

const COMPOSIO_BIN = "composio";

/**
 * Where the CLI persists the logged-in session, incl. the issued `api_key`.
 * Resolve HOME the same way `runComposio` sets it for the spawned CLI
 * (`process.env.HOME ?? homedir()`), so we always read the session out of the
 * exact directory the CLI just wrote it to.
 */
function credFilePath(): string {
  return join(process.env.HOME ?? homedir(), ".composio", "user_data.json");
}

export type CliLoginErrorCode =
  | "spawn_failed"
  | "parse_failed"
  | "not_authorized"
  | "cli_failed"
  | "canceled"
  | "no_key";

export class CliLoginError extends Error {
  constructor(
    message: string,
    readonly code: CliLoginErrorCode,
  ) {
    super(message);
    this.name = "CliLoginError";
  }
}

export interface CliLoginSession {
  loginUrl: string;
  cliKey: string;
}

interface RunResult {
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
  canceled: boolean;
}

/**
 * Spawn the CLI with a minimal environment — only HOME (so it finds/writes
 * ~/.composio) and PATH (so the binary + its node runtime resolve). Never
 * inherit the full parent env: it would leak the daemon's secrets and git
 * state into a third-party subprocess. Args are passed as an array (no shell),
 * so a hostile `cliKey` can't inject commands.
 *
 * `signal` aborts the run: it SIGTERMs the child so a blocking `login --key`
 * (which otherwise waits for the guardian to authorize) stops promptly. This is
 * how a canceled browser login actually halts server-side instead of running to
 * completion and persisting a key the guardian backed out of.
 */
function runComposio(
  args: string[],
  opts: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<RunResult> {
  const { timeoutMs, signal } = opts;
  return new Promise((resolve, reject) => {
    const child = spawn(COMPOSIO_BIN, args, {
      env: {
        HOME: process.env.HOME ?? homedir(),
        PATH: process.env.PATH ?? "",
      },
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let canceled = false;
    const timer = timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGTERM");
        }, timeoutMs)
      : undefined;

    const onAbort = () => {
      canceled = true;
      child.kill("SIGTERM");
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (err) => {
      cleanup();
      reject(err);
    });
    child.on("close", (code) => {
      cleanup();
      resolve({ stdout, stderr, code, timedOut, canceled });
    });
  });
}

/**
 * The dashboard login URL the CLI emits, in either output format. Its `cliKey`
 * query param carries the opaque session key — the same value the legacy JSON
 * surfaced as `cli_key` — so it is the one field we can recover from both shapes.
 */
const LOGIN_URL_RE = /https:\/\/dashboard\.composio\.dev\/\?[^\s"'<>]*cliKey=[^\s"'<>]+/i;

/**
 * Parse the login URL + session key out of `composio login --no-wait`, tolerating
 * both CLI output contracts:
 *
 *   - **Legacy (<=0.2.27):** clean JSON `{ "login_url": ..., "cli_key": ... }`
 *     on stdout (the update-available banner goes to stderr; we still slice to
 *     the outermost braces defensively in case a stray line leaks in).
 *   - **Current (>=0.2.32):** human-readable text ("Open this URL in your
 *     browser…") with the session key riding in the URL's `cliKey` param and no
 *     JSON at all. The CLI was pinned to 0.2.32 while this parser still assumed
 *     the 0.2.27 JSON, so a text-only output failed to parse and sign-in never
 *     started.
 *
 * The JSON contract is tried first (it is authoritative when present); the text
 * scrape is the fallback. Both ultimately yield the same `cliKey`.
 */
export function parseLoginSession(stdout: string): CliLoginSession {
  const json = sliceJsonObject(stdout);
  let sawJsonObject = false;
  if (json) {
    let data: { login_url?: unknown; cli_key?: unknown } | undefined;
    try {
      data = JSON.parse(json);
      sawJsonObject = true;
    } catch {
      // Not valid JSON after all — fall through to the text scrape.
    }
    if (data && typeof data.login_url === "string" && typeof data.cli_key === "string") {
      return { loginUrl: data.login_url, cliKey: data.cli_key };
    }
  }

  const fromText = parseLoginSessionFromText(stdout);
  if (fromText) return fromText;

  if (sawJsonObject) {
    throw new CliLoginError(
      `composio login output missing login_url/cli_key: ${json}`,
      "parse_failed",
    );
  }
  throw new CliLoginError(
    `Could not parse composio login output: ${stdout.trim() || "(empty)"}`,
    "parse_failed",
  );
}

/**
 * Recover the session from the current CLI's plain-text login output by scraping
 * the dashboard URL and reading its `cliKey`. Returns null when no such URL is
 * present so the caller can raise a precise parse error.
 */
function parseLoginSessionFromText(stdout: string): CliLoginSession | null {
  const stripped = stdout.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
  const match = stripped.match(LOGIN_URL_RE);
  if (!match) return null;
  const loginUrl = match[0].replace(/[),.;]+$/g, "");
  let cliKey: string | null;
  try {
    cliKey = new URL(loginUrl).searchParams.get("cliKey");
  } catch {
    return null;
  }
  if (!cliKey) return null;
  return { loginUrl, cliKey };
}

/** Extract the issued `api_key` from the CLI's `user_data.json` contents. */
export function parseApiKeyFromSession(raw: string): string {
  let data: { api_key?: unknown };
  try {
    data = JSON.parse(raw);
  } catch {
    throw new CliLoginError("Composio CLI session file is malformed", "no_key");
  }
  const key = typeof data.api_key === "string" ? data.api_key.trim() : "";
  if (!key) {
    throw new CliLoginError("Composio login completed but no API key was issued", "no_key");
  }
  return key;
}

function sliceJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;
  return text.slice(start, end + 1);
}

function spawnError(err: unknown): CliLoginError {
  const detail = err instanceof Error ? err.message : String(err);
  return new CliLoginError(
    `Failed to run the Composio CLI (${detail}). Is the \`composio\` CLI installed and on PATH?`,
    "spawn_failed",
  );
}

/** Step 1: start a CLI login session and return the URL for the guardian to authorize. */
export async function startCliLogin(): Promise<CliLoginSession> {
  let result: RunResult;
  try {
    result = await runComposio(["login", "--no-wait", "--no-browser", "--no-skill-install"]);
  } catch (err) {
    throw spawnError(err);
  }
  return parseLoginSession(result.stdout);
}

/**
 * Clear any active CLI session. The CLI short-circuits `composio login` while a
 * session already exists (it prints nothing and exits), so "log in again" /
 * switch-account must log out first to get a fresh authorization URL. Logout is
 * idempotent — running it with no session still exits 0 — so callers don't need
 * to check for an existing session first.
 */
export async function logoutCliSession(): Promise<void> {
  try {
    await runComposio(["logout"]);
  } catch (err) {
    throw spawnError(err);
  }
}

/**
 * Step 2: complete the login the guardian authorized in their browser, then
 * read the issued API key. `composio login --key` blocks until the session is
 * authorized, so `timeoutMs` bounds the wait — a timeout means the guardian
 * hasn't finished authorizing yet (surfaced as `not_authorized`).
 */
export async function completeCliLogin(
  cliKey: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<string> {
  let result: RunResult;
  try {
    result = await runComposio(["login", "--key", cliKey, "--no-skill-install", "-y"], {
      timeoutMs,
      signal,
    });
  } catch (err) {
    throw spawnError(err);
  }
  // Aborted before the CLI finished — the guardian canceled. Bail before reading
  // the session so a canceled login never persists a key.
  if (result.canceled) {
    throw new CliLoginError("Composio login was canceled.", "canceled");
  }
  // Our own SIGTERM after `timeoutMs`: the CLI was still blocking, i.e. the
  // guardian hasn't authorized yet. This is the retryable "keep waiting" case.
  if (result.timedOut) {
    throw new CliLoginError(
      "Timed out waiting for Composio authorization. Finish authorizing in the opened tab, then try again.",
      "not_authorized",
    );
  }
  // A non-zero exit that we did NOT time out is the CLI deciding to fail —
  // denied authorization, an expired `cliKey`, etc. That's terminal: surface it
  // as `cli_failed` so the dashboard stops retrying and shows the reason, rather
  // than re-issuing forever as it does for `not_authorized`.
  if (result.code !== 0) {
    throw new CliLoginError(
      `Composio login did not complete: ${result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`}`,
      "cli_failed",
    );
  }
  return readApiKeyFromSession();
}

/** Read the CLI's session file, or null if it doesn't exist yet. */
async function readSessionFile(): Promise<string | null> {
  try {
    return await readFile(credFilePath(), "utf8");
  } catch {
    return null;
  }
}

async function readApiKeyFromSession(): Promise<string> {
  const raw = await readSessionFile();
  if (raw === null) {
    throw new CliLoginError(
      "Composio CLI session file not found after login — the CLI did not persist a key.",
      "no_key",
    );
  }
  return parseApiKeyFromSession(raw);
}

/**
 * Return the API key from the CLI session, or `null` if the CLI isn't logged in.
 * "Not logged in" is a legitimate state — the guardian may never have run
 * `composio login` — so it returns null rather than throwing.
 *
 * This is the single live credential read for the whole app: every action,
 * webhook, and status check resolves the key through here, so the CLI session
 * (`~/.composio/user_data.json`) stays the one source of truth and the app keeps
 * no copy. A key the guardian minted in a terminal is picked up automatically,
 * with no import step.
 */
export async function readSessionApiKey(): Promise<string | null> {
  const raw = await readSessionFile();
  if (raw === null) return null;
  try {
    return parseApiKeyFromSession(raw);
  } catch {
    return null;
  }
}

/**
 * The organization of the CLI session (`org_id`, "ok_…"), which a user key
 * sends as `x-org-id` beside a project id. Null when not logged in.
 */
export async function readSessionOrgId(): Promise<string | null> {
  const raw = await readSessionFile();
  if (raw === null) return null;
  try {
    const data = JSON.parse(raw) as { org_id?: unknown };
    return typeof data.org_id === "string" && data.org_id.trim() ? data.org_id.trim() : null;
  } catch {
    return null;
  }
}

/** One developer project of the signed-in Composio account. */
export interface CliProject {
  id: string;
  name: string;
}

/** Reads the project list out of `composio dev projects list`, tolerating a banner around the JSON. */
export function parseCliProjects(stdout: string): CliProject[] {
  const start = stdout.indexOf("[");
  const end = stdout.lastIndexOf("]");
  if (start < 0 || end < start) {
    throw new Error(`Could not read the Composio project list: ${stdout.trim() || "(empty)"}`);
  }
  const rows = JSON.parse(stdout.slice(start, end + 1)) as unknown;
  if (!Array.isArray(rows)) throw new Error("The Composio project list is not a list");
  return rows.flatMap((row) => {
    const { id, name } = (row ?? {}) as { id?: unknown; name?: unknown };
    return typeof id === "string" && id ? [{ id, name: typeof name === "string" ? name : id }] : [];
  });
}

/** The account's developer projects, as `composio dev projects list` gives them. */
export async function listCliProjects(): Promise<CliProject[]> {
  let result: RunResult;
  try {
    result = await runComposio(["dev", "projects", "list"], { timeoutMs: 15_000 });
  } catch (err) {
    throw spawnError(err);
  }
  if (result.code !== 0) {
    throw new Error(
      `composio dev projects list failed: ${result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`}`,
    );
  }
  return parseCliProjects(result.stdout);
}
