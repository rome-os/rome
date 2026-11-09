// The Sessions repository port: what the agent context needs from the store
// that keeps sessions. Adapters live in agent/infrastructure/.
// Aggregate: ./session.ts. Vocabulary: docs/concepts/sessions.md.

import type { AgentName, ContinuityKey, Session, SessionId, TurnCheckpoint } from "./session.js";

/** Thrown by `add` when the continuity key and agent already have an active session. */
export class ActiveSessionExistsError extends Error {
  constructor(
    readonly continuityKey: ContinuityKey,
    readonly agentName: AgentName,
    readonly activeSessionId: SessionId,
  ) {
    super(`Session "${activeSessionId}" is already active for this continuity key and agent`);
    this.name = "ActiveSessionExistsError";
  }
}

/**
 * The collection of sessions. Finds them by id or by continuity key, adds new
 * ones, and writes their changes. The only way sessions reach storage.
 */
export interface SessionRepository {
  /** The session, or null when none has the id. Never creates one. */
  session(id: SessionId): Promise<Session | null>;

  /** Whether a reset replaced another session with session `id`. */
  succeeds(id: SessionId): Promise<boolean>;

  /** The active session for this continuity key and agent, or null. Idle time
   *  never retires a session. */
  current(continuityKey: ContinuityKey, agentName: AgentName): Promise<Session | null>;

  /**
   * Adds a new session, with any turn it recorded before being added. Throws
   * `ActiveSessionExistsError` when the session has a continuity key and a
   * session is already active for it and exactly this agent. Whoever opens
   * sessions serializes `add` per continuity key, so two opens at once cannot
   * both pass the check.
   */
  add(session: Session): Promise<void>;

  /**
   * Writes the facts the session changed since it was last saved, and the
   * checkpoints recorded since then. Only changed facts are written, so two
   * instances of one session that change different facts both keep their
   * writes. A completion is never undone. The session must have been added.
   */
  save(session: Session): Promise<void>;

  /**
   * A reset, in one transaction: writes the retired session, completed, and
   * adds its successor from `retired.replace()`, with any turn the successor
   * recorded before the reset was written. Every other session still active
   * for the same continuity key and exact agent is completed too, so the
   * successor is the only one. The successor keeps the chat the chat side
   * recorded for the retired session. Whoever resets serializes this per
   * continuity key.
   */
  replace(retired: Session, successor: Session): Promise<void>;

  /** @deprecated The dashboard reads a turn's checkpoint only to hand it back
   *  to a fork. Goes when the session resolves its own fork point. */
  deprecatedCheckpoint(sessionId: SessionId, turnId: string): Promise<TurnCheckpoint | null>;
}
