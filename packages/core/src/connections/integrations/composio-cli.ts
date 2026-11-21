import { execFile, spawn, type ChildProcessByStdio } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import { delimiter, join } from "node:path";
import type { Readable } from "node:stream";
import { KeyedMutex } from "../../lib/keyed-mutex.js";

const COMPOSIO_INSTALL_PATHS = ["/home/rome/.composio", "/usr/local/lib/composio"];
const LOGIN_URL_RE = /https:\/\/dashboard\.composio\.dev\/\?[^\s"'<>]*cliKey=[^\s"'<>]+/i;
const MAX_LOGIN_OUTPUT_LENGTH = 20_000;
// How long the /login request waits for the CLI to print its authorize URL.
const LOGIN_URL_TIMEOUT_MS = 15_000;

/**
 * Serializes every credential-mutating Composio ceremony on one key so login and
 * logout can never interleave their `~/.composio` writes. The login ceremony
 * (spawn `composio login`, then `composio login --poll`) holds the lock for its
 * whole life; `logoutComposio` aborts any in-flight ceremony first (so cancel is
 * responsive) and then takes the same lock, guaranteeing `composio logout` runs
 * only after the aborted ceremony has torn down. Same primitive the connections
 * registry uses for grant/section ceremonies.
 */
const loginMutex = new KeyedMutex();
const LOGIN_LOCK_KEY = "composio-login";

interface ComposioUserData {
  api_key?: unknown;
  base_url?: unknown;
  web_url?: unknown;
  org_id?: unknown;
  test_user_id?: unknown;
}

export interface ComposioCliStatus {
  installed: boolean;
  loggedIn: boolean;
  loginPending: boolean;
  webUrl: string | null;
  orgId: string | null;
  testUserId: string | null;
  error: string | null;
}

/**
 * A single in-flight browser-login ceremony. It owns an {@link AbortController}
 * that logout (or a superseding login) trips to kill the `login`/`--poll`
 * children promptly, and surfaces its authorize URL to the /login request via
 * `urlWaiters` while the poll keeps running under the mutex. `active` stays true
 * until the whole ceremony (login + poll) settles; `error` captures a terminal
 * failure so status can report it instead of silently reading "not logged in".
 */
interface LoginCeremony {
  controller: AbortController;
  output: string;
  loginUrl: string | null;
  active: boolean;
  error: string | null;
  urlWaiters: Array<{
    resolve: (url: string) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }>;
}

let ceremony: LoginCeremony | null = null;
let installedCache: { value: boolean; checkedAt: number } | null = null;

function getComposioEnv(): NodeJS.ProcessEnv {
  const path = [...COMPOSIO_INSTALL_PATHS, process.env.PATH ?? ""].filter(Boolean).join(delimiter);

  return {
    ...process.env,
    PATH: path,
  };
}

function getPathExecutableCandidates(command: string, searchPath: string): string[] {
  const extensions =
    process.platform === "win32" && !/\.[^\\/]+$/.test(command)
      ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
          .split(";")
          .map((extension) => extension.trim())
          .filter(Boolean)
      : [""];

  const seen = new Set<string>();
  const candidates: string[] = [];

  for (const rawDirectory of searchPath.split(delimiter)) {
    const directory = rawDirectory || process.cwd();

    for (const extension of extensions) {
      const candidate = join(directory, `${command}${extension}`);
      if (!seen.has(candidate)) {
        seen.add(candidate);
        candidates.push(candidate);
      }
    }
  }

  return candidates;
}

async function isExecutableFile(path: string): Promise<boolean> {
  try {
    const fileStat = await stat(path);
    if (!fileStat.isFile()) {
      return false;
    }

    await access(path, process.platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function executableExistsOnPath(
  command: string,
  searchPath: string,
): Promise<boolean> {
  if (!command || command.includes("/") || command.includes("\\")) {
    return false;
  }

  const checks = getPathExecutableCandidates(command, searchPath).map((candidate) =>
    isExecutableFile(candidate),
  );
  const results = await Promise.all(checks);
  return results.some(Boolean);
}

function getUserDataPath(): string {
  return join(process.env.HOME || "/home/rome", ".composio", "user_data.json");
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Command failed";
}

function trimCommandOutput(output: string): string {
  return output
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-8)
    .join("\n");
}

function normalizeUrlCandidate(value: string): string | null {
  const trimmed = value.replace(/[),.;]+$/g, "");

  try {
    const url = new URL(trimmed);
    if (url.protocol !== "https:" || url.hostname !== "dashboard.composio.dev") {
      return null;
    }
    if (!url.searchParams.has("cliKey")) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

export function extractComposioLoginUrl(output: string): string | null {
  const stripped = output.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
  const match = stripped.match(LOGIN_URL_RE);
  return match ? normalizeUrlCandidate(match[0]) : null;
}

function execComposio(
  args: string[],
  timeout = 10_000,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      "composio",
      args,
      {
        env: getComposioEnv(),
        timeout,
        maxBuffer: 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(error);
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

async function composioCliInstalled(): Promise<boolean> {
  if (installedCache && Date.now() - installedCache.checkedAt < 30_000) {
    return installedCache.value;
  }

  const installed = await executableExistsOnPath("composio", getComposioEnv().PATH ?? "");
  installedCache = { value: installed, checkedAt: Date.now() };
  return installed;
}

async function readStoredUserData(): Promise<ComposioUserData | null> {
  try {
    const raw = await readFile(getUserDataPath(), "utf8");
    return JSON.parse(raw) as ComposioUserData;
  } catch {
    return null;
  }
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function hasStoredApiKey(userData: ComposioUserData | null): boolean {
  return (
    stringOrNull(userData?.api_key) !== null || stringOrNull(process.env.COMPOSIO_API_KEY) !== null
  );
}

function hasActiveLoginSession(): boolean {
  return ceremony?.active ?? false;
}

export async function getComposioStatus(): Promise<ComposioCliStatus> {
  const [installed, userData] = await Promise.all([composioCliInstalled(), readStoredUserData()]);

  if (!installed) {
    return {
      installed: false,
      loggedIn: false,
      loginPending: hasActiveLoginSession(),
      webUrl: stringOrNull(userData?.web_url),
      orgId: stringOrNull(userData?.org_id),
      testUserId: stringOrNull(userData?.test_user_id),
      error: "Composio CLI is not installed or is not on PATH.",
    };
  }

  const loggedIn = hasStoredApiKey(userData);
  return {
    installed: true,
    loggedIn,
    loginPending: hasActiveLoginSession(),
    webUrl: stringOrNull(userData?.web_url),
    orgId: stringOrNull(userData?.org_id),
    testUserId: stringOrNull(userData?.test_user_id),
    // Surface a terminal ceremony failure (e.g. `--poll` exited without saving
    // credentials) once it is no longer pending — otherwise a failed completion
    // reads as a plain "not logged in" and the caller waits out its full deadline,
    // reproducing the very hang this flow fixes. Cleared on the next login attempt.
    error: loggedIn ? null : ceremony && !ceremony.active ? ceremony.error : null,
  };
}

function rejectCeremonyWaiters(c: LoginCeremony, error: Error): void {
  for (const waiter of c.urlWaiters.splice(0)) {
    clearTimeout(waiter.timer);
    waiter.reject(error);
  }
}

function resolveCeremonyWaiters(c: LoginCeremony, loginUrl: string): void {
  for (const waiter of c.urlWaiters.splice(0)) {
    clearTimeout(waiter.timer);
    waiter.resolve(loginUrl);
  }
}

function appendCeremonyOutput(c: LoginCeremony, chunk: Buffer): void {
  c.output = `${c.output}${chunk.toString("utf8")}`.slice(-MAX_LOGIN_OUTPUT_LENGTH);
  const loginUrl = extractComposioLoginUrl(c.output);
  if (loginUrl && !c.loginUrl) {
    c.loginUrl = loginUrl;
    resolveCeremonyWaiters(c, loginUrl);
  }
}

/** Resolve the authorize URL the ceremony scraped, or fail if it already ended
 *  without one. Awaited by the /login request; the ceremony itself keeps going. */
function waitForCeremonyUrl(c: LoginCeremony, timeoutMs: number): Promise<string> {
  if (c.loginUrl) {
    return Promise.resolve(c.loginUrl);
  }
  if (!c.active) {
    return Promise.reject(
      new Error(
        c.error ||
          trimCommandOutput(c.output) ||
          "Composio login exited before printing a login URL.",
      ),
    );
  }
  return new Promise((resolve, reject) => {
    const waiter = {
      resolve,
      reject,
      timer: setTimeout(() => {
        c.urlWaiters = c.urlWaiters.filter((candidate) => candidate !== waiter);
        reject(new Error("Timed out waiting for Composio login URL."));
      }, timeoutMs),
    };
    c.urlWaiters.push(waiter);
  });
}

/** Await a child's exit code, killing it if `signal` aborts and rejecting on a
 *  spawn error. The abort path is how logout tears the ceremony's processes down. */
function waitForChildExit(
  child: ChildProcessByStdio<null, Readable, Readable>,
  signal: AbortSignal,
): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const onAbort = () => child.kill("SIGTERM");
    if (signal.aborted) child.kill("SIGTERM");
    else signal.addEventListener("abort", onAbort, { once: true });
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    child.once("error", (err) => {
      cleanup();
      reject(err);
    });
    child.once("exit", (code) => {
      cleanup();
      resolve(code);
    });
  });
}

/**
 * The full browser-login ceremony, run under the login mutex so it never
 * interleaves with logout. Two CLI contracts are handled in one flow:
 *
 *   - **Legacy CLI (<=0.2.27):** `composio login` blocks until the guardian
 *     authorizes and persists the key itself, so once it exits with a URL seen
 *     and a key on disk, we're done.
 *   - **Current CLI (>=0.2.32):** `composio login` prints the URL and exits
 *     immediately; completion is a separate `composio login --poll` that waits
 *     (up to ~10 min) for authorization and writes the key. Without this step
 *     the guardian authorizes but nothing collects the result and status reads
 *     "not logged in" forever — the hang this fixes.
 *
 * Both children are killed promptly if the ceremony's abort signal trips (logout
 * or a superseding login). A terminal failure throws; the caller records it on
 * the ceremony so status can surface it.
 */
async function runLoginCeremony(c: LoginCeremony): Promise<void> {
  const { signal } = c.controller;
  if (signal.aborted) return;

  // Step 1 — mint the authorize URL.
  const login = spawn("composio", ["login", "--no-browser", "-y", "--no-skill-install"], {
    env: getComposioEnv(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  login.stdout.on("data", (chunk: Buffer) => appendCeremonyOutput(c, chunk));
  login.stderr.on("data", (chunk: Buffer) => appendCeremonyOutput(c, chunk));
  const loginExit = await waitForChildExit(login, signal);
  if (signal.aborted) return;

  if (!c.loginUrl) {
    throw new Error(
      trimCommandOutput(c.output) ||
        `Composio login exited before printing a login URL (code ${loginExit ?? "unknown"}).`,
    );
  }

  // Legacy CLI already persisted the key by the time `login` returned.
  if (hasStoredApiKey(await readStoredUserData())) return;
  if (signal.aborted) return;

  // Step 2 — the current CLI's completer.
  const poll = spawn("composio", ["login", "--poll", "-y", "--no-skill-install"], {
    env: getComposioEnv(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  // Capture the poll's own output separately so a completion failure surfaces the
  // poll's error, not the (noisy) login URL banner already in `c.output`.
  let pollOutput = "";
  const capturePoll = (chunk: Buffer) => {
    pollOutput = `${pollOutput}${chunk.toString("utf8")}`.slice(-MAX_LOGIN_OUTPUT_LENGTH);
  };
  poll.stdout.on("data", capturePoll);
  poll.stderr.on("data", capturePoll);
  const pollExit = await waitForChildExit(poll, signal);
  if (signal.aborted) return;

  // A poll that exits without a key on disk is a completion failure — surface it
  // instead of leaving status silently "not logged in".
  if (!hasStoredApiKey(await readStoredUserData())) {
    const detail = trimCommandOutput(pollOutput);
    throw new Error(
      `Composio login --poll exited (code ${pollExit ?? "unknown"}) without saving credentials.${
        detail ? ` ${detail}` : ""
      }`,
    );
  }
}

/**
 * Create a ceremony and kick it off detached under the login mutex. We hold the
 * lock across the whole login → poll (so logout can't interleave), but only
 * `await` the URL in `startComposioLogin`; the poll keeps running here until it
 * completes, fails, or is aborted.
 */
function startLoginCeremony(): LoginCeremony {
  const c: LoginCeremony = {
    controller: new AbortController(),
    output: "",
    loginUrl: null,
    active: true,
    error: null,
    urlWaiters: [],
  };
  ceremony = c;

  void loginMutex
    .runExclusive(LOGIN_LOCK_KEY, () => runLoginCeremony(c))
    .catch((err: unknown) => {
      c.error = getErrorMessage(err);
    })
    .finally(() => {
      c.active = false;
      // Fail any request still awaiting the URL (only fires when none arrived).
      rejectCeremonyWaiters(
        c,
        new Error(c.error || "Composio login ended before a URL was available."),
      );
    });

  return c;
}

export async function startComposioLogin(): Promise<{
  loginUrl: string;
  status: ComposioCliStatus;
}> {
  const status = await getComposioStatus();
  if (!status.installed) {
    throw new Error(status.error || "Composio CLI is not installed.");
  }

  // Reuse an in-flight ceremony rather than minting a second URL for the same
  // pending login; otherwise start a fresh one.
  const c = ceremony?.active ? ceremony : startLoginCeremony();
  const loginUrl = await waitForCeremonyUrl(c, LOGIN_URL_TIMEOUT_MS);
  return {
    loginUrl,
    status: await getComposioStatus(),
  };
}

export async function logoutComposio(): Promise<ComposioCliStatus> {
  // Interrupt any in-flight login ceremony first so cancel is responsive and no
  // `--poll` can persist a key after logout. Aborting kills its children; the
  // ceremony then releases the login lock.
  ceremony?.controller.abort();
  ceremony = null;

  // Take the same lock so `composio logout` runs only after the aborted ceremony
  // has fully torn down — never interleaving credential writes with a live poll.
  return loginMutex.runExclusive(LOGIN_LOCK_KEY, async () => {
    try {
      await execComposio(["logout"], 10_000);
    } catch (error) {
      throw new Error(getErrorMessage(error));
    }
    return getComposioStatus();
  });
}
