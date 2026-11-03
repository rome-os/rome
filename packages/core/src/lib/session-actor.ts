import { AsyncLocalStorage } from "node:async_hooks";
import { getCookie } from "hono/cookie";
import type { Context, MiddlewareHandler } from "hono";
import { guardianAuth } from "../db/schema.js";
import type { DrizzleDb } from "../db/index.js";
import { createLogger } from "../logger.js";
import { VISITOR_COOKIE_NAME, verifyVisitorSession } from "./auth.js";
import {
  guardianSessionMaterial,
  resolveGuardianSessionFromMaterial,
  type GuardianSession,
  type GuardianSessionMaterial,
} from "./guardian-session.js";

const log = createLogger("session-actor");

/**
 * The authenticated session identity accountable for a piece of work — the
 * "who did this" answer stamped on `action_executions.actor`. Orthogonal to an
 * execution's `initiator` (the triggering mechanism, e.g. `app:dream`): the
 * actor is the human session the request chain originated from.
 *
 * Only ever constructed host-side from verified session material — never from
 * request headers or app-supplied input, so it cannot be forged.
 */
export type SessionActor =
  | {
      kind: "guardian";
      /** Canonical guardian seat id (`guardian_auth.user_id`), not the raw JWT
       * subject — cloud logins mint the session with the Rome Cloud accountId,
       * so the JWT subject is not stable across login methods. */
      userId: string;
      /** Rome Cloud account the seat is bound to, when cloud-bound. */
      accountId?: string;
      /** Email of the bound cloud account, when known. */
      email?: string;
      /** How guardianship was proven: a browser session cookie, or a trusted
       * in-container loopback caller acting as the seat. */
      via: "cookie" | "loopback";
    }
  | { kind: "visitor"; accountId: string; email: string }
  /** A sessionless entry on a session-capable surface (public /api routes,
   * the app WS server). Distinct from an absent actor, which means no
   * accountable session could exist anywhere in the chain — agent-autonomous
   * work, routines, startup, and machine-credential surfaces (/webhooks). */
  | { kind: "anonymous" };

/** Raw request material actor resolution needs; extends the guardian material
 * with the visitor cookie so one capture covers both session kinds. */
export interface SessionActorMaterial extends GuardianSessionMaterial {
  visitorToken: string | null;
}

export function sessionActorMaterial(c: Context): SessionActorMaterial {
  return {
    ...guardianSessionMaterial(c),
    visitorToken: getCookie(c, VISITOR_COOKIE_NAME) ?? null,
  };
}

/**
 * Widen a resolved guardian session into a `SessionActor` using the single
 * guardian seat row: normalizes the JWT subject to the canonical seat userId
 * and fills in the cloud accountId/email when the seat is bound.
 */
export async function enrichGuardianActor(
  db: DrizzleDb,
  session: GuardianSession,
): Promise<SessionActor> {
  const [seat] = await db
    .select({
      userId: guardianAuth.userId,
      accountId: guardianAuth.accountId,
      email: guardianAuth.email,
    })
    .from(guardianAuth)
    .limit(1);
  return {
    kind: "guardian",
    userId: seat?.userId ?? session.userId,
    ...(seat?.accountId ? { accountId: seat.accountId } : {}),
    ...(seat?.email ? { email: seat.email } : {}),
    via: session.via,
  };
}

/**
 * Resolve the actor for a request. Mirrors the app-api caller precedence
 * (`RomeAppCaller`): guardian wins over a coexisting visitor session; a
 * sessionless request is `anonymous`.
 */
export async function resolveSessionActorFromMaterial(
  material: SessionActorMaterial,
  db: DrizzleDb,
): Promise<SessionActor> {
  const guardian = await resolveGuardianSessionFromMaterial(material, db);
  if (guardian) return enrichGuardianActor(db, guardian);

  const visitor = material.visitorToken ? verifyVisitorSession(material.visitorToken) : null;
  if (visitor) return { kind: "visitor", accountId: visitor.accountId, email: visitor.email };

  return { kind: "anonymous" };
}

/** NULL owners belong to the guardian for listing, but never match an anonymous viewer. */
export function sessionOwnerKey(actor: SessionActor | undefined): string | null {
  if (actor?.kind === "guardian") return "guardian";
  if (actor?.kind === "visitor") return `visitor:${actor.accountId}`;
  return null;
}

interface SessionActorHandle {
  get(): Promise<SessionActor | undefined>;
}

const sessionActorContext = new AsyncLocalStorage<SessionActorHandle>();

function toHandle(source: SessionActor | (() => Promise<SessionActor>)): SessionActorHandle {
  if (typeof source !== "function") {
    const resolved = Promise.resolve<SessionActor | undefined>(source);
    return { get: () => resolved };
  }
  // Lazy + memoized: requests that never run an action pay nothing, and every
  // action in one request shares a single resolution. Fail-open — a resolution
  // error must not fail the action, it just leaves the actor unrecorded.
  let pending: Promise<SessionActor | undefined> | undefined;
  return {
    get: () => {
      pending ??= source().catch((err: unknown) => {
        log.warn("session actor resolution failed", {
          error: err instanceof Error ? err.message : String(err),
        });
        return undefined;
      });
      return pending;
    },
  };
}

/**
 * Run `fn` with an ambient session actor. Accepts either an already-resolved
 * actor (WS upgrade path) or a lazy resolver (HTTP middleware). The ambient
 * value is what `ActionEngine` stamps on root executions whose callers did not
 * pass an explicit `actor`.
 */
export function runWithSessionActor<T>(
  source: SessionActor | (() => Promise<SessionActor>),
  fn: () => T,
): T {
  return sessionActorContext.run(toHandle(source), fn);
}

/** The ambient actor for the current async context, or undefined outside any
 * `runWithSessionActor` scope (agent-autonomous work, routines, startup). */
export async function currentSessionActor(): Promise<SessionActor | undefined> {
  return sessionActorContext.getStore()?.get();
}

/**
 * Run `fn` outside any ambient session-actor scope. Async resources capture
 * the ALS context they are *created* in, so a timer registered while handling
 * an /api request would attribute every later autonomous fire to that
 * request's session. Wrap the registration of anything that outlives the
 * request (cron jobs, watchers) so its fires resolve no actor, per the audit
 * contract (autonomous work = NULL, not the session that registered it).
 */
export function withoutSessionActor<T>(fn: () => T): T {
  return sessionActorContext.exit(fn);
}

/**
 * Annotate-only middleware: captures session material and exposes the actor
 * ambiently for the request. Never gates — auth enforcement stays at the Caddy
 * edge (`/api/auth/verify`); this exists so any action run during the request
 * is attributable without every route threading identity by hand.
 */
export function sessionActorMiddleware(db: DrizzleDb): MiddlewareHandler {
  return (c, next) => {
    const material = sessionActorMaterial(c);
    return runWithSessionActor(() => resolveSessionActorFromMaterial(material, db), next);
  };
}
