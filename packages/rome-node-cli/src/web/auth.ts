import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { join } from "node:path";
import { isRecord } from "@rome-os/node-core";
import { writePrivateJson } from "@rome-os/node-core/storage";

const SESSION_COOKIE = "rome_node_session";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_SESSIONS = 64;
const RATE_LIMIT_FREE_ATTEMPTS = 5;
const RATE_LIMIT_BASE_COOLDOWN_MS = 30_000;
const RATE_LIMIT_MAX_COOLDOWN_MS = 15 * 60_000;
const RATE_LIMIT_DECAY_MS = 30 * 60_000;
const RATE_LIMIT_MAX_KEYS = 1024;
const AUTH_FILE_NAME = "web-auth.json";
const SCRYPT_KEY_LENGTH = 64;
const SCRYPT_OPTIONS = { N: 16_384, r: 8, p: 1 };
export const MIN_PASSWORD_LENGTH = 6;
export const MAX_PASSWORD_LENGTH = 256;

interface RateLimitState {
  failures: number;
  inFlight: number;
  lockedUntil: number;
  lastFailureAt: number;
}

export type PasswordSource = "none" | "setup" | "file" | "env";

interface StoredPasswordRecord {
  version: 1;
  salt: string;
  hash: string;
}

interface ActivePassword {
  salt: Buffer;
  hash: Buffer;
}

export interface WebAuthOptions {
  host: string;
  configDirectory?: string;
  password?: string;
  now?: () => number;
}

type SetupResult =
  | { status: "ok"; sessionId: string }
  | { status: "invalid_token" }
  | { status: "conflict" };

type RateLimitReservation =
  | {
      allowed: true;
      finish(outcome: "success" | "failure" | "abort"): void;
    }
  | {
      allowed: false;
      retryAfterSeconds: number;
    };

export interface WebAuth {
  readonly authRequired: boolean;
  readonly passwordSource: PasswordSource;
  readonly canRemovePassword: boolean;
  readonly setupToken: string | null;
  isLoopbackRequest(req: IncomingMessage): boolean;
  isTrustedHost(req: IncomingMessage): boolean;
  isAuthenticated(req: IncomingMessage): boolean;
  checkSameOrigin(req: IncomingMessage): boolean;
  reserveLoginAttempt(remoteAddress: string): RateLimitReservation;
  verifyPassword(candidate: string): Promise<boolean>;
  completeSetup(token: string, newPassword: string): Promise<SetupResult>;
  setPassword(newPassword: string): Promise<string>;
  removePassword(): Promise<void>;
  createSession(): string;
  clearSession(req: IncomingMessage): void;
  sessionCookieHeader(sessionId: string, secure: boolean): string;
  clearSessionCookieHeader(secure: boolean): string;
}

export function isLoopbackAddress(address: string | undefined): boolean {
  if (typeof address !== "string") return false;
  const normalized = address
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  if (normalized === "::1" || normalized === "127.0.0.1") {
    return true;
  }
  if (/^::ffff:127(?:\.\d{1,3}){3}$/.test(normalized)) {
    return normalized
      .slice("::ffff:".length)
      .split(".")
      .every((part) => Number(part) <= 255);
  }
  if (/^127(?:\.\d{1,3}){3}$/.test(normalized)) {
    return normalized.split(".").every((part) => Number(part) <= 255);
  }
  return false;
}

export function isLoopbackHost(host: string): boolean {
  const normalized = host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  if (normalized === "localhost") return true;
  return isLoopbackAddress(normalized);
}

function parseHostHeaderHostname(hostHeader: string | undefined): string | null {
  if (typeof hostHeader !== "string") return null;
  const trimmed = hostHeader.trim();
  if (!trimmed || /[\s@/?#\\]/.test(trimmed)) return null;
  try {
    const parsed = new URL(`http://${trimmed}`);
    if (parsed.host.toLowerCase() !== trimmed.toLowerCase()) return null;
    return parsed.hostname;
  } catch {
    return null;
  }
}

function sha256(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function deriveKey(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, SCRYPT_KEY_LENGTH, SCRYPT_OPTIONS, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(derivedKey);
    });
  });
}

async function hashPassword(password: string): Promise<ActivePassword> {
  const salt = randomBytes(16);
  const hash = await deriveKey(password, salt);
  return { salt, hash };
}

function parseStoredPassword(raw: unknown): ActivePassword | null {
  if (!isRecord(raw) || raw.version !== 1) return null;
  if (typeof raw.salt !== "string" || typeof raw.hash !== "string") return null;
  if (!/^[0-9a-f]{32}$/i.test(raw.salt) || !/^[0-9a-f]{128}$/i.test(raw.hash)) return null;
  const salt = Buffer.from(raw.salt, "hex");
  const hash = Buffer.from(raw.hash, "hex");
  if (salt.byteLength !== 16 || hash.byteLength !== SCRYPT_KEY_LENGTH) return null;
  return { salt, hash };
}

export function validateNewPassword(candidate: unknown): string | null {
  if (typeof candidate !== "string") return "Password must be a string.";
  if (candidate.trim().length === 0) return "Password cannot be empty or whitespace only.";
  if (candidate.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  if (candidate.length > MAX_PASSWORD_LENGTH) {
    return `Password must be at most ${MAX_PASSWORD_LENGTH} characters.`;
  }
  return null;
}

function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) return {};
  const result: Record<string, string> = {};
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator <= 0) continue;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (key) result[key] = value;
  }
  return result;
}

export function isSecureRequest(req: IncomingMessage): boolean {
  if ("encrypted" in req.socket && Boolean((req.socket as { encrypted?: boolean }).encrypted)) {
    return true;
  }
  const forwarded = req.headers["x-forwarded-proto"];
  if (typeof forwarded === "string") {
    return forwarded.split(",")[0]?.trim().toLowerCase() === "https";
  }
  return false;
}

export async function createWebAuth(options: WebAuthOptions): Promise<WebAuth> {
  const now = options.now ?? (() => Date.now());
  const bindIsLoopback = isLoopbackHost(options.host);
  const authPath = options.configDirectory ? join(options.configDirectory, AUTH_FILE_NAME) : null;
  const envPassword = options.password?.trim() ? options.password : undefined;

  let passwordSource: PasswordSource = "none";
  let activePassword: ActivePassword | null = null;
  let setupToken: string | null = null;
  let setupTokenDigest: Buffer | null = null;
  let setupInFlight = false;

  if (envPassword !== undefined) {
    activePassword = await hashPassword(envPassword);
    passwordSource = "env";
  } else if (authPath) {
    let rawText: string | null = null;
    try {
      rawText = await readFile(authPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new Error(
          `Failed to read Web UI password file (${authPath}): ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (rawText !== null) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawText);
      } catch {
        throw new Error(
          `Web UI password file (${authPath}) is corrupted. Repair or remove it, or set ROME_NODE_UI_PASSWORD.`,
        );
      }
      const stored = parseStoredPassword(parsed);
      if (!stored) {
        throw new Error(
          `Web UI password file (${authPath}) has an invalid format. Repair or remove it, or set ROME_NODE_UI_PASSWORD.`,
        );
      }
      activePassword = stored;
      passwordSource = "file";
    }
  }

  if (passwordSource === "none" && !bindIsLoopback) {
    setupToken = randomBytes(18).toString("base64url");
    setupTokenDigest = sha256(setupToken);
    passwordSource = "setup";
  }

  const sessions = new Map<string, number>();
  const rateLimits = new Map<string, RateLimitState>();

  function pruneSessions(currentTime: number): void {
    for (const [id, expiresAt] of sessions) {
      if (expiresAt <= currentTime) sessions.delete(id);
    }
    while (sessions.size > MAX_SESSIONS) {
      const oldest = sessions.keys().next().value;
      if (oldest === undefined) break;
      sessions.delete(oldest);
    }
  }

  function pruneRateLimits(currentTime: number): void {
    for (const [key, state] of rateLimits) {
      if (
        state.inFlight === 0 &&
        currentTime >= state.lockedUntil &&
        currentTime - state.lastFailureAt >= RATE_LIMIT_DECAY_MS
      ) {
        rateLimits.delete(key);
      }
    }
    while (rateLimits.size >= RATE_LIMIT_MAX_KEYS) {
      const oldest = rateLimits.keys().next().value;
      if (oldest === undefined) break;
      const candidate = rateLimits.get(oldest);
      if (candidate && candidate.inFlight > 0) break;
      rateLimits.delete(oldest);
    }
  }

  function isLoopbackRequest(req: IncomingMessage): boolean {
    if (!bindIsLoopback) return false;
    if (!isLoopbackAddress(req.socket.localAddress)) return false;
    if (!isLoopbackAddress(req.socket.remoteAddress)) return false;

    const hostname = parseHostHeaderHostname(req.headers.host);
    if (hostname === null || !isLoopbackHost(hostname)) return false;

    const forwardedHost = req.headers["x-forwarded-host"];
    if (typeof forwardedHost === "string" && forwardedHost.trim() !== "") {
      const firstHost = forwardedHost.split(",")[0]?.trim();
      const parsedForwardedHost = parseHostHeaderHostname(firstHost);
      if (parsedForwardedHost === null || !isLoopbackHost(parsedForwardedHost)) return false;
    }

    const forwardedFor = req.headers["x-forwarded-for"];
    if (typeof forwardedFor === "string" && forwardedFor.trim() !== "") {
      const hops = forwardedFor
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean);
      if (hops.length === 0 || !hops.every((hop) => isLoopbackAddress(hop))) return false;
    }

    return true;
  }

  function isTrustedHost(req: IncomingMessage): boolean {
    if (passwordSource !== "none") return true;
    return isLoopbackRequest(req);
  }

  async function verifyPassword(candidate: string): Promise<boolean> {
    if (passwordSource === "none") return true;
    if (!activePassword || !candidate) return false;
    const derived = await deriveKey(candidate, activePassword.salt);
    return timingSafeEqual(derived, activePassword.hash);
  }

  function isAuthenticated(req: IncomingMessage): boolean {
    if (passwordSource === "none") return isTrustedHost(req);
    if (passwordSource === "setup") return false;
    const sessionId = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (!sessionId) return false;
    const currentTime = now();
    const expiresAt = sessions.get(sessionId);
    if (expiresAt === undefined) return false;
    if (expiresAt <= currentTime) {
      sessions.delete(sessionId);
      return false;
    }
    return true;
  }

  function checkSameOrigin(req: IncomingMessage): boolean {
    if (!isTrustedHost(req)) return false;
    const fetchSite = req.headers["sec-fetch-site"];
    if (typeof fetchSite === "string" && fetchSite !== "same-origin" && fetchSite !== "none") {
      return false;
    }
    const origin = req.headers.origin;
    if (typeof origin !== "string") return true;
    const host = req.headers.host;
    if (!host) return false;
    try {
      const parsedOrigin = new URL(origin);
      if (passwordSource === "none" && !isLoopbackHost(parsedOrigin.hostname)) return false;
      return parsedOrigin.host.toLowerCase() === host.toLowerCase();
    } catch {
      return false;
    }
  }

  function reserveLoginAttempt(remoteAddress: string): RateLimitReservation {
    const key = remoteAddress || "unknown";
    const currentTime = now();
    let state = rateLimits.get(key);
    if (
      state &&
      state.inFlight === 0 &&
      state.failures > 0 &&
      currentTime >= state.lockedUntil &&
      currentTime - state.lastFailureAt >= RATE_LIMIT_DECAY_MS
    ) {
      rateLimits.delete(key);
      state = undefined;
    }

    if (state && currentTime < state.lockedUntil) {
      const retryAfterSeconds = Math.max(1, Math.ceil((state.lockedUntil - currentTime) / 1000));
      return { allowed: false, retryAfterSeconds };
    }

    const failuresSoFar = state?.failures ?? 0;
    const active = state?.inFlight ?? 0;
    const maxConcurrent =
      failuresSoFar < RATE_LIMIT_FREE_ATTEMPTS ? RATE_LIMIT_FREE_ATTEMPTS - failuresSoFar : 1;
    if (active >= maxConcurrent) {
      return { allowed: false, retryAfterSeconds: 1 };
    }

    if (!state) {
      pruneRateLimits(currentTime);
      state = { failures: 0, inFlight: 0, lockedUntil: 0, lastFailureAt: 0 };
      rateLimits.set(key, state);
    }
    const trackedState = state;
    trackedState.inFlight += 1;

    let finished = false;
    return {
      allowed: true,
      finish(outcome: "success" | "failure" | "abort") {
        if (finished) return;
        finished = true;
        trackedState.inFlight = Math.max(0, trackedState.inFlight - 1);

        if (outcome === "success") {
          trackedState.failures = 0;
          trackedState.lockedUntil = 0;
          trackedState.lastFailureAt = 0;
          if (trackedState.inFlight === 0) {
            rateLimits.delete(key);
          }
          return;
        }

        if (outcome === "failure") {
          const failTime = now();
          trackedState.failures += 1;
          trackedState.lastFailureAt = failTime;
          if (trackedState.failures >= RATE_LIMIT_FREE_ATTEMPTS) {
            const exponent = Math.min(trackedState.failures - RATE_LIMIT_FREE_ATTEMPTS, 10);
            const cooldownMs = Math.min(
              RATE_LIMIT_MAX_COOLDOWN_MS,
              RATE_LIMIT_BASE_COOLDOWN_MS * 2 ** exponent,
            );
            trackedState.lockedUntil = Math.max(trackedState.lockedUntil, failTime + cooldownMs);
          }
          return;
        }

        if (trackedState.inFlight === 0 && trackedState.failures === 0) {
          rateLimits.delete(key);
        }
      },
    };
  }

  function createSession(): string {
    const currentTime = now();
    pruneSessions(currentTime);
    const id = randomBytes(32).toString("base64url");
    sessions.set(id, currentTime + SESSION_TTL_MS);
    return id;
  }

  async function saveFilePassword(newPassword: string): Promise<string> {
    if (!authPath) {
      throw new Error("Configuration directory is not available for password storage.");
    }
    const next = await hashPassword(newPassword);
    const record: StoredPasswordRecord = {
      version: 1,
      salt: next.salt.toString("hex"),
      hash: next.hash.toString("hex"),
    };
    await writePrivateJson(authPath, record);
    activePassword = next;
    passwordSource = "file";
    setupToken = null;
    setupTokenDigest = null;
    sessions.clear();
    return createSession();
  }

  async function completeSetup(token: string, newPassword: string): Promise<SetupResult> {
    if (passwordSource !== "setup" || !setupTokenDigest || setupInFlight) {
      return { status: "conflict" };
    }
    if (!token || !timingSafeEqual(sha256(token), setupTokenDigest)) {
      return { status: "invalid_token" };
    }
    setupInFlight = true;
    try {
      if (passwordSource !== "setup" || !setupTokenDigest) {
        return { status: "conflict" };
      }
      const sessionId = await saveFilePassword(newPassword);
      return { status: "ok", sessionId };
    } finally {
      setupInFlight = false;
    }
  }

  async function setPassword(newPassword: string): Promise<string> {
    return saveFilePassword(newPassword);
  }

  async function removePassword(): Promise<void> {
    if (!authPath) {
      throw new Error("Configuration directory is not available for password storage.");
    }
    if (!bindIsLoopback) {
      throw new Error("Password cannot be removed on a non-loopback bind.");
    }
    await rm(authPath, { force: true });
    activePassword = null;
    passwordSource = "none";
    sessions.clear();
  }

  function clearSession(req: IncomingMessage): void {
    const sessionId = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (sessionId) sessions.delete(sessionId);
  }

  function sessionCookieHeader(sessionId: string, secure: boolean): string {
    const maxAge = Math.floor(SESSION_TTL_MS / 1000);
    return `${SESSION_COOKIE}=${sessionId}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
  }

  function clearSessionCookieHeader(secure: boolean): string {
    return `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure ? "; Secure" : ""}`;
  }

  return {
    get authRequired() {
      return passwordSource !== "none";
    },
    get passwordSource() {
      return passwordSource;
    },
    get canRemovePassword() {
      return bindIsLoopback;
    },
    get setupToken() {
      return setupToken;
    },
    isLoopbackRequest,
    isTrustedHost,
    isAuthenticated,
    checkSameOrigin,
    reserveLoginAttempt,
    verifyPassword,
    completeSetup,
    setPassword,
    removePassword,
    createSession,
    clearSession,
    sessionCookieHeader,
    clearSessionCookieHeader,
  };
}
