// The Sessions repository over `sessions` and `session_turn_checkpoints`.
// Aggregate: sessions/session.ts. Vocabulary: docs/concepts/sessions.md.

import { and, desc, eq } from "drizzle-orm";
import { resolveArtifactId, type ArtifactIdentityContext } from "../apps/artifact-id.js";
import type { DrizzleDb } from "../db/index.js";
import { sessions, sessionTurnCheckpoints } from "../db/schema.js";
import {
  Session,
  type AgentName,
  type ContinuityKey,
  type SessionId,
  type SessionState,
  type TurnCheckpoint,
} from "./session.js";

type SessionRow = typeof sessions.$inferSelect;

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
 * ones, and writes their changes. Together with `db/repositories/sessions.ts`,
 * which it replaces, it is the only code that touches `sessions` and
 * `session_turn_checkpoints`.
 */
export class SessionRepository {
  constructor(
    private readonly db: DrizzleDb,
    private readonly identity: ArtifactIdentityContext,
  ) {}

  /** The session, or null when none has the id. Never creates one. */
  async session(id: SessionId): Promise<Session | null> {
    const rows = await this.db.select().from(sessions).where(eq(sessions.id, id));
    return rows[0] ? restore(rows[0]) : null;
  }

  /**
   * The active session for this continuity key and agent, or null. Idle time
   * never retires a session.
   * @deprecated behaviour: the agent also matches under its legacy names,
   * which is identity resolution Sessions should not do. Goes when agent names
   * are canonical before they reach Sessions.
   */
  async current(continuityKey: ContinuityKey, agentName: AgentName): Promise<Session | null> {
    const rows = await this.db
      .select()
      .from(sessions)
      .where(and(eq(sessions.channelThreadKey, continuityKey), eq(sessions.status, "active")))
      .orderBy(desc(sessions.createdAt), desc(sessions.lastActiveAt));
    const row = rows.find((candidate) => this.sameAgent(candidate.agentName, agentName));
    return row ? restore(row) : null;
  }

  /**
   * Adds a new session. Throws `ActiveSessionExistsError` when the session
   * has a continuity key and a session is already active for it and exactly
   * this agent. Whoever opens sessions serializes `add` per continuity key, so
   * two opens at once cannot both pass the check.
   */
  async add(session: Session): Promise<void> {
    const state = session.snapshot();
    this.db.transaction((tx) => {
      if (state.continuityKey !== null) {
        const active = tx
          .select({ id: sessions.id })
          .from(sessions)
          .where(exactlyActive(state.continuityKey, state.agentName))
          .get();
        if (active) {
          throw new ActiveSessionExistsError(state.continuityKey, state.agentName, active.id);
        }
      }
      tx.insert(sessions).values(toRow(state)).run();
    });
  }

  /** Writes the session's state, and the checkpoint recorded since it was
   *  last saved, if any. The session must have been added. */
  async save(session: Session): Promise<void> {
    const state = session.snapshot();
    const checkpoint = session.takeCheckpoint();
    this.db.transaction((tx) => {
      const result = tx
        .update(sessions)
        .set(mutableColumns(state))
        .where(eq(sessions.id, state.id))
        .run();
      if (result.changes === 0) throw new Error(`Session "${state.id}" was never added`);
      if (checkpoint) upsertCheckpoint(tx, checkpoint);
    });
  }

  /**
   * A reset, in one transaction: writes the retired session, completed, and
   * adds its successor from `retired.replace()`. Every other session still
   * active for the same continuity key and exact agent is completed too, so
   * the successor is the only one. Whoever resets serializes this per
   * continuity key.
   */
  async replace(retired: Session, successor: Session): Promise<void> {
    const retiredState = retired.snapshot();
    const successorState = successor.snapshot();
    if (retiredState.status === "active") {
      throw new Error(`Session "${retiredState.id}" was not completed before its replacement`);
    }
    if (
      successorState.continuityKey !== retiredState.continuityKey ||
      successorState.agentName !== retiredState.agentName
    ) {
      throw new Error(`Session "${successorState.id}" does not succeed "${retiredState.id}"`);
    }
    this.db.transaction((tx) => {
      tx.update(sessions)
        .set(mutableColumns(retiredState))
        .where(eq(sessions.id, retiredState.id))
        .run();
      if (retiredState.continuityKey !== null) {
        tx.update(sessions)
          .set({ status: "completed", lastActiveAt: retiredState.lastActiveAt })
          .where(exactlyActive(retiredState.continuityKey, retiredState.agentName))
          .run();
      }
      tx.insert(sessions).values(toRow(successorState)).run();
    });
  }

  /** @deprecated The dashboard reads a turn's checkpoint only to hand it back
   *  to a fork. Goes when the session resolves its own fork point. */
  async deprecatedCheckpoint(sessionId: SessionId, turnId: string): Promise<TurnCheckpoint | null> {
    const rows = await this.db
      .select({
        sessionId: sessionTurnCheckpoints.sessionId,
        turnId: sessionTurnCheckpoints.turnId,
        provider: sessionTurnCheckpoints.provider,
        providerThreadId: sessionTurnCheckpoints.providerThreadId,
        checkpointId: sessionTurnCheckpoints.checkpointId,
      })
      .from(sessionTurnCheckpoints)
      .where(
        and(
          eq(sessionTurnCheckpoints.sessionId, sessionId),
          eq(sessionTurnCheckpoints.turnId, turnId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  private sameAgent(storedName: string, requestedName: string): boolean {
    if (storedName === requestedName) return true;
    try {
      const legacyBindings = this.identity.legacyBindings;
      return (
        resolveArtifactId({ kind: "agent", value: storedName, legacyBindings }) ===
        resolveArtifactId({ kind: "agent", value: requestedName, legacyBindings })
      );
    } catch {
      return false;
    }
  }
}

type Tx = Parameters<Parameters<DrizzleDb["transaction"]>[0]>[0];

function exactlyActive(continuityKey: ContinuityKey, agentName: AgentName) {
  return and(
    eq(sessions.channelThreadKey, continuityKey),
    eq(sessions.agentName, agentName),
    eq(sessions.status, "active"),
  );
}

function upsertCheckpoint(tx: Tx, checkpoint: TurnCheckpoint): void {
  const now = new Date();
  tx.insert(sessionTurnCheckpoints)
    .values({ ...checkpoint, createdAt: now })
    .onConflictDoUpdate({
      target: [sessionTurnCheckpoints.sessionId, sessionTurnCheckpoints.turnId],
      set: {
        provider: checkpoint.provider,
        providerThreadId: checkpoint.providerThreadId,
        checkpointId: checkpoint.checkpointId,
        createdAt: now,
      },
    })
    .run();
}

function restore(row: SessionRow): Session {
  return Session.restore({
    id: row.id,
    agentName: row.agentName,
    continuityKey: row.channelThreadKey,
    status: row.status,
    provider: row.provider,
    providerThreadId: row.providerThreadId,
    model: row.model,
    reasoningEffort: row.reasoningEffort,
    workingDir: row.workingDir,
    createdAt: row.createdAt,
    lastActiveAt: row.lastActiveAt,
    chatId: row.chatId,
  });
}

function mutableColumns(state: SessionState) {
  return {
    status: state.status,
    provider: state.provider,
    providerThreadId: state.providerThreadId,
    model: state.model,
    reasoningEffort: state.reasoningEffort,
    workingDir: state.workingDir,
    lastActiveAt: state.lastActiveAt,
    chatId: state.chatId,
  };
}

function toRow(state: SessionState): SessionRow {
  return {
    id: state.id,
    agentName: state.agentName,
    channelThreadKey: state.continuityKey,
    chatId: state.chatId,
    provider: state.provider,
    providerThreadId: state.providerThreadId,
    model: state.model,
    reasoningEffort: state.reasoningEffort,
    workingDir: state.workingDir,
    createdAt: state.createdAt,
    lastActiveAt: state.lastActiveAt,
    status: state.status,
  };
}
