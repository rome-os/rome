import bcrypt from "bcrypt";
import { setCookie } from "hono/cookie";
import type { Context } from "hono";
import jwt, { type JwtPayload } from "jsonwebtoken";

const SALT_ROUNDS = 12;

// Guardian session lifetime. Defaults to 30 days; the desktop runtime overrides it
// (via ROME_SESSION_MAX_AGE_SECONDS) to ~1 year so a locally-enrolled Mac app
// doesn't make the user re-authenticate after enrollment. Drives both the JWT
// `expiresIn` and the cookie `maxAge` so the two never drift.
const DEFAULT_SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;
const SESSION_MAX_AGE_SECONDS =
  Number(process.env.ROME_SESSION_MAX_AGE_SECONDS) || DEFAULT_SESSION_MAX_AGE_SECONDS;

export const JWT_SECRET = process.env.ROME_JWT_SECRET || "rome-dev-secret-change-me";
export const COOKIE_NAME = "rome_session";
export const VISITOR_COOKIE_NAME = "rome_visitor";
const VISITOR_SESSION_KIND = "visitor";

interface HeaderAccessor {
  get(name: string): string | null | undefined;
}

export function shouldSecureCookie(
  request?: { header: (name: string) => string | undefined } | { headers: HeaderAccessor },
): boolean {
  if (process.env.NODE_ENV !== "production") return false;
  if (request) {
    const proto =
      "header" in request
        ? request.header("x-forwarded-proto")
        : request.headers.get("x-forwarded-proto");
    if (proto) return proto === "https";
  }
  if (process.env.ROME_COOKIE_SECURE === "false") return false;
  return true;
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, SALT_ROUNDS);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

export function createSession(userId: string): string {
  return jwt.sign({ userId }, JWT_SECRET, { expiresIn: SESSION_MAX_AGE_SECONDS });
}

export interface SessionEnvelope {
  token: string;
  expiresAt: string;
}

// Native callers need the same guardian session material that browser login
// writes as a cookie. Decode the expiry from the signed token itself so the
// JSON metadata and JWT can never drift.
export function createGuardianSession(userId: string): SessionEnvelope {
  return sessionEnvelope(createSession(userId));
}

function sessionEnvelope(token: string): SessionEnvelope {
  const decoded = jwt.decode(token);
  if (!decoded || typeof decoded === "string" || typeof decoded.exp !== "number") {
    throw new Error("session token has no expiry");
  }
  return { token, expiresAt: new Date(decoded.exp * 1000).toISOString() };
}

export interface VisitorSession {
  kind: typeof VISITOR_SESSION_KIND;
  accountId: string;
  email: string;
  favorViewerToken?: string;
  avatarUrl?: string | null;
}

export function createVisitorSession(
  accountId: string,
  email: string,
  favorViewerToken?: string,
  avatarUrl?: string | null,
): string {
  return jwt.sign(
    {
      kind: VISITOR_SESSION_KIND,
      accountId,
      email,
      favorViewerToken,
      avatarUrl,
    },
    JWT_SECRET,
    { expiresIn: SESSION_MAX_AGE_SECONDS },
  );
}

// The native visitor sign-in returns the same visitor session the web flow
// sets as a cookie. Rome Cloud's id_token carries no favor viewer token, so a
// native visitor session has none.
export function createVisitorSessionEnvelope(
  accountId: string,
  email: string,
  avatarUrl?: string | null,
): SessionEnvelope {
  return sessionEnvelope(createVisitorSession(accountId, email, undefined, avatarUrl));
}

/**
 * Mint a guardian session JWT and write it as the session cookie. The single
 * seam every login path goes through, so the cookie attributes (httpOnly,
 * secure, sameSite, path, maxAge) stay identical across `/auth/login`,
 * `/oauth/redeem`, and `/onboard/create-account`.
 */
export function issueGuardianSession(c: Context, userId: string): void {
  const session = createGuardianSession(userId);
  setCookie(c, COOKIE_NAME, session.token, {
    httpOnly: true,
    secure: shouldSecureCookie(c.req.raw),
    sameSite: "Lax",
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS,
  });
}

export function issueVisitorSession(
  c: Context,
  accountId: string,
  email: string,
  favorViewerToken?: string,
  avatarUrl?: string | null,
): void {
  setCookie(
    c,
    VISITOR_COOKIE_NAME,
    createVisitorSession(accountId, email, favorViewerToken, avatarUrl),
    {
      httpOnly: true,
      secure: shouldSecureCookie(c.req.raw),
      sameSite: "Lax",
      path: "/",
      maxAge: SESSION_MAX_AGE_SECONDS,
    },
  );
}

export function verifySession(token: string): { userId: string } | null {
  try {
    const payload = jwt.verify(token, JWT_SECRET) as JwtPayload & {
      userId?: unknown;
      kind?: unknown;
    };
    if (payload.kind !== undefined) return null;
    if (typeof payload.userId !== "string" || payload.userId === "") return null;
    return { userId: payload.userId };
  } catch {
    return null;
  }
}

export function verifyVisitorSession(token: string): VisitorSession | null {
  try {
    const payload = jwt.verify(token, JWT_SECRET) as JwtPayload & {
      kind?: unknown;
      accountId?: unknown;
      email?: unknown;
      favorViewerToken?: unknown;
      avatarUrl?: unknown;
    };
    if (payload.kind !== VISITOR_SESSION_KIND) return null;
    if (typeof payload.accountId !== "string" || payload.accountId === "") return null;
    if (typeof payload.email !== "string" || payload.email === "") return null;
    return {
      kind: VISITOR_SESSION_KIND,
      accountId: payload.accountId,
      email: payload.email,
      favorViewerToken:
        typeof payload.favorViewerToken === "string" && payload.favorViewerToken !== ""
          ? payload.favorViewerToken
          : undefined,
      avatarUrl:
        typeof payload.avatarUrl === "string" && payload.avatarUrl !== ""
          ? payload.avatarUrl
          : payload.avatarUrl === null
            ? null
            : undefined,
    };
  } catch {
    return null;
  }
}
