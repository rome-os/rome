import type { Context } from "hono";
import { getCookie } from "hono/cookie";
import { getConnInfo } from "@hono/node-server/conninfo";
import { guardianAuth } from "../db/schema.js";
import type { DrizzleDb } from "../db/index.js";
import { COOKIE_NAME, verifySession } from "./auth.js";
import { isLoopbackAddress } from "./trusted-loopback.js";

export interface GuardianSession {
  userId: string;
  via: "cookie" | "loopback";
}

/**
 * The raw request material guardian resolution needs, for callers that don't
 * have a Hono context (e.g. the WebSocket upgrade path, which only has a Node
 * `IncomingMessage`).
 */
export interface GuardianSessionMaterial {
  /** Value of the guardian session cookie, if present. */
  sessionToken: string | null;
  /** True when the request carried an `X-Forwarded-For` header. */
  hasForwardedFor: boolean;
  /** TCP peer address as reported by the socket; undefined fails closed. */
  peerAddress: string | undefined;
}

// The single source of truth for "is this request the guardian?" — shared by
// `/auth/me`, the bootstrap phase, and the app-api dispatch so they never
// drift. A valid cookie is the normal path;
// absent that, an in-container loopback caller (agent-driven browser, headless
// CDP) is reported as the guardian, because the container is the security
// boundary and such callers already have unrestricted API access (see
// lib/trusted-loopback.ts for why this is not forgeable from outside). Returns
// null when neither holds.
export async function resolveGuardianSessionFromMaterial(
  material: GuardianSessionMaterial,
  db: DrizzleDb,
): Promise<GuardianSession | null> {
  const session = material.sessionToken ? verifySession(material.sessionToken) : null;
  if (session) return { userId: session.userId, via: "cookie" };

  // Same invariant as lib/trusted-loopback.ts: loopback peer + no XFF header
  // (every fronting proxy stamps XFF; a client can only add one, which demotes
  // it — never strip it).
  if (!material.hasForwardedFor && isLoopbackAddress(material.peerAddress)) {
    const [guardian] = await db.select({ userId: guardianAuth.userId }).from(guardianAuth).limit(1);
    if (guardian) return { userId: guardian.userId, via: "loopback" };
  }

  return null;
}

export function guardianSessionMaterial(c: Context): GuardianSessionMaterial {
  return {
    sessionToken: getCookie(c, COOKIE_NAME) ?? null,
    // Truthiness (not presence) to stay aligned with lib/trusted-loopback.ts.
    hasForwardedFor: Boolean(c.req.header("x-forwarded-for")),
    peerAddress: peerAddress(c),
  };
}

export async function resolveGuardianSession(
  c: Context,
  db: DrizzleDb,
): Promise<GuardianSession | null> {
  return resolveGuardianSessionFromMaterial(guardianSessionMaterial(c), db);
}

function peerAddress(c: Context): string | undefined {
  // getConnInfo requires the @hono/node-server bindings; anything else
  // (tests without an env, non-node adapters) fails closed.
  try {
    return getConnInfo(c).remote.address;
  } catch {
    return undefined;
  }
}
