import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

const SESSION_COOKIE = "rome_node_session";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_SESSIONS = 64;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_FAILURES = 10;

export interface WebAuthOptions {
  host: string;
  token?: string;
  requireAuth?: boolean;
  now?: () => number;
}

export interface WebAuth {
  readonly authRequired: boolean;
  readonly tokenGenerated: boolean;
  readonly initialToken: string | null;
  isTrustedHost(req: IncomingMessage): boolean;
  isAuthenticated(req: IncomingMessage): boolean;
  checkSameOrigin(req: IncomingMessage): boolean;
  checkLoginRateLimit(
    remoteAddress: string,
  ): { allowed: true } | { allowed: false; retryAfterSeconds: number };
  recordLoginFailure(remoteAddress: string): void;
  clearLoginFailures(remoteAddress: string): void;
  verifyToken(candidate: string): boolean;
  createSession(): string;
  clearSession(req: IncomingMessage): void;
  sessionCookieHeader(sessionId: string, secure: boolean): string;
  clearSessionCookieHeader(secure: boolean): string;
}

export function isLoopbackHost(host: string): boolean {
  const normalized = host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  if (normalized === "localhost" || normalized === "::1" || normalized === "127.0.0.1") {
    return true;
  }
  if (/^127(?:\.\d{1,3}){3}$/.test(normalized)) {
    return normalized.split(".").every((part) => Number(part) <= 255);
  }
  return false;
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

export function createWebAuth(options: WebAuthOptions): WebAuth {
  const now = options.now ?? (() => Date.now());
  const provided = options.token?.trim() || undefined;
  const authRequired = Boolean(provided || options.requireAuth || !isLoopbackHost(options.host));
  const tokenGenerated = authRequired && !provided;
  const activeToken = authRequired ? (provided ?? randomBytes(24).toString("base64url")) : null;
  const expectedDigest = activeToken ? sha256(activeToken) : null;

  const sessions = new Map<string, number>();
  const failures = new Map<string, number[]>();

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

  function verifyToken(candidate: string): boolean {
    if (!expectedDigest) return true;
    if (!candidate) return false;
    return timingSafeEqual(sha256(candidate), expectedDigest);
  }

  function isTrustedHost(req: IncomingMessage): boolean {
    if (authRequired) return true;
    const hostname = parseHostHeaderHostname(req.headers.host);
    return hostname !== null && isLoopbackHost(hostname);
  }

  function isAuthenticated(req: IncomingMessage): boolean {
    if (!authRequired) return isTrustedHost(req);
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
      if (!authRequired && !isLoopbackHost(parsedOrigin.hostname)) return false;
      return parsedOrigin.host.toLowerCase() === host.toLowerCase();
    } catch {
      return false;
    }
  }

  function checkLoginRateLimit(
    remoteAddress: string,
  ): { allowed: true } | { allowed: false; retryAfterSeconds: number } {
    const key = remoteAddress || "unknown";
    const currentTime = now();
    const cutoff = currentTime - RATE_LIMIT_WINDOW_MS;
    const recent = (failures.get(key) ?? []).filter((at) => at > cutoff);
    if (recent.length === 0) {
      failures.delete(key);
      return { allowed: true };
    }
    failures.set(key, recent);
    if (recent.length >= RATE_LIMIT_MAX_FAILURES) {
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((recent[0] + RATE_LIMIT_WINDOW_MS - currentTime) / 1000),
      );
      return { allowed: false, retryAfterSeconds };
    }
    return { allowed: true };
  }

  function recordLoginFailure(remoteAddress: string): void {
    const key = remoteAddress || "unknown";
    const currentTime = now();
    const cutoff = currentTime - RATE_LIMIT_WINDOW_MS;
    const recent = (failures.get(key) ?? []).filter((at) => at > cutoff);
    recent.push(currentTime);
    failures.set(key, recent);
  }

  function clearLoginFailures(remoteAddress: string): void {
    failures.delete(remoteAddress || "unknown");
  }

  function createSession(): string {
    const currentTime = now();
    pruneSessions(currentTime);
    const id = randomBytes(32).toString("base64url");
    sessions.set(id, currentTime + SESSION_TTL_MS);
    return id;
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
    authRequired,
    tokenGenerated,
    initialToken: tokenGenerated ? activeToken : null,
    isTrustedHost,
    isAuthenticated,
    checkSameOrigin,
    checkLoginRateLimit,
    recordLoginFailure,
    clearLoginFailures,
    verifyToken,
    createSession,
    clearSession,
    sessionCookieHeader,
    clearSessionCookieHeader,
  };
}
