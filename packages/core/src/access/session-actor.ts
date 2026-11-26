import { AsyncLocalStorage } from "node:async_hooks";
import type { IncomingMessage } from "node:http";
import { getCookie } from "hono/cookie";
import type { Context, MiddlewareHandler } from "hono";
import { guardianAuth } from "../db/schema.js";
import type { DrizzleDb } from "../db/index.js";
import { createLogger } from "../logger.js";
import { readCookie } from "../lib/ws-upgrade.js";
import { COOKIE_NAME, VISITOR_COOKIE_NAME, verifyVisitorSession } from "./auth.js";
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
 * actor is the human the request chain originated from, by their session or by
 * their account on a platform (application/account-entry.ts).
 *
 * Only ever constructed host-side from verified session material or that
 * account — never from request headers or app-supplied input, so it cannot be
 * forged.
 */
export type SessionActor =
  | {
      kind: "guardian";
      /** Canonical guardian seat id (`guardian_auth.user_id`), not the raw JWT
       * subject — cloud logins mint the session with the Rome Cloud accountId,
       * so the JWT subject is not stable across login methods. From
       * {@link readSessionActor} alone, the JWT subject. */
      userId: string;
      /** Rome Cloud account the seat is bound to, when cloud-bound. */
      accountId?: string;
      /** Email of the bound cloud account, when known. */
      email?: string;
      /** How guardianship was proven: a browser session cookie, a trusted
       * in-container loopback caller acting as the seat, or the account on a
       * platform that said or pressed something there. */
      via: "cookie" | "loopback" | "account";
    }
  | { kind: "visitor"; accountId: string; email: string }
  /** An entry on a session-capable surface (/api routes, the app WS server)
   * whose session names no one, or could not be read. Distinct from an absent
   * actor, which means no accountable session could exist anywhere in the
   * chain — agent-autonomous work, routines, startup, and machine-credential
   * surfaces (/webhooks). */
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

/** What {@link sessionActorMaterial} reads, from a WebSocket upgrade. */
export function upgradeActorMaterial(req: IncomingMessage): SessionActorMaterial {
  return {
    sessionToken: readCookie(req.headers.cookie, COOKIE_NAME),
    hasForwardedFor: Boolean(req.headers["x-forwarded-for"]),
    peerAddress: req.socket.remoteAddress ?? undefined,
    visitorToken: readCookie(req.headers.cookie, VISITOR_COOKIE_NAME),
  };
}

/**
 * Widen a resolved guardian session into a `SessionActor` using the single
 * guardian seat row: normalizes the JWT subject to the canonical seat userId
 * and fills in the cloud accountId/email when the seat is bound.
 */
export async function enrichGuardianActor(
  db: DrizzleDb,
  session: Pick<Extract<SessionActor, { kind: "guardian" }>, "userId" | "via">,
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
 * The person a request's session names. Mirrors the app-api caller precedence
 * (`RomeAppCaller`): guardian wins over a coexisting visitor session; a
 * sessionless request is `anonymous`. A guardian's `userId` is the one their
 * session carries. Reads the database only for a loopback peer.
 */
export async function readSessionActor(
  material: SessionActorMaterial,
  db: DrizzleDb,
): Promise<SessionActor> {
  const guardian = await resolveGuardianSessionFromMaterial(material, db);
  if (guardian) return { kind: "guardian", userId: guardian.userId, via: guardian.via };

  const visitor = material.visitorToken ? verifyVisitorSession(material.visitorToken) : null;
  if (visitor) return { kind: "visitor", accountId: visitor.accountId, email: visitor.email };

  return { kind: "anonymous" };
}

/** {@link readSessionActor}, with the guardian as their seat names them. */
export async function resolveSessionActorFromMaterial(
  material: SessionActorMaterial,
  db: DrizzleDb,
): Promise<SessionActor> {
  const actor = await readSessionActor(material, db);
  return actor.kind === "guardian" ? enrichGuardianActor(db, actor) : actor;
}

/** The guardian as the actor of work no person started, such as an app's routine. Undefined before a seat exists. */
export async function guardianActor(db: DrizzleDb): Promise<SessionActor | undefined> {
  const [seat] = await db.select({ userId: guardianAuth.userId }).from(guardianAuth).limit(1);
  return seat ? { kind: "guardian", userId: seat.userId, via: "loopback" } : undefined;
}

/** NULL owners belong to the guardian for listing, but never match an anonymous viewer. */
export function sessionOwnerKey(actor: Exclude<SessionActor, { kind: "anonymous" }>): string;
export function sessionOwnerKey(actor: SessionActor | undefined): string | null;
export function sessionOwnerKey(actor: SessionActor | undefined): string | null {
  if (actor?.kind === "guardian") return "guardian";
  if (actor?.kind === "visitor") return `visitor:${actor.accountId}`;
  return null;
}

/**
 * Whose chats the current request may open: the signed-in person's, and no
 * one's when no person can be told. Work Rome does on its own opens chats
 * without asking.
 */
export async function currentChatOwner(): Promise<string | null> {
  return sessionOwnerKey(await currentSessionActor());
}

interface SessionActorHandle {
  get(): Promise<SessionActor>;
}

const sessionActorContext = new AsyncLocalStorage<SessionActorHandle>();

function toHandle(source: SessionActor | (() => Promise<SessionActor>)): SessionActorHandle {
  if (typeof source !== "function") {
    const resolved = Promise.resolve(source);
    return { get: () => resolved };
  }
  // Lazy + memoized: requests that never run an action pay nothing, and every
  // action in one request shares a single resolution. A resolution error does
  // not fail the work, which then runs for a person no one can tell.
  let pending: Promise<SessionActor> | undefined;
  return {
    get: () => {
      pending ??= source().catch((err: unknown) => {
        log.warn("session actor resolution failed", {
          error: err instanceof Error ? err.message : String(err),
        });
        return { kind: "anonymous" as const };
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
 * ambiently for the request. Never gates: the entry step does
 * (docs/architecture/access-control.md#entry). This exists so any action run
 * during the request is attributable without every route threading identity by
 * hand.
 */
export function sessionActorMiddleware(db: DrizzleDb): MiddlewareHandler {
  return (c, next) => {
    const material = sessionActorMaterial(c);
    return runWithSessionActor(() => resolveSessionActorFromMaterial(material, db), next);
  };
}
