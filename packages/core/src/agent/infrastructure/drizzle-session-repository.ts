// The Drizzle adapter of the Sessions repository port, over `sessions` and
// `session_turn_checkpoints`. Port: agent/domain/session-repository.ts.
// Aggregate: agent/domain/session.ts.

import { and, desc, eq } from "drizzle-orm";
import type { DrizzleDb, DrizzleTx } from "../../db/index.js";
import { sessions, sessionTurnCheckpoints } from "../../db/schema.js";
import {
  Session,
  type AgentName,
  type ContinuityKey,
  type SessionChange,
  type SessionId,
  type SessionState,
  type TurnCheckpoint,
} from "../domain/session.js";
import { ActiveSessionExistsError, type SessionRepository } from "../domain/session-repository.js";

type SessionRow = typeof sessions.$inferSelect;

/**
 * The Sessions repository over SQLite through Drizzle. It is the only code
 * that touches `sessions` and `session_turn_checkpoints`, except the
 * `chat_id` column: the web chat side reads and records which chat has a
 * session there (`chatOfSession`, `recordSessionInChat` in
 * webchat/repository.ts).
 */
export class DrizzleSessionRepository implements SessionRepository {
  constructor(private readonly db: DrizzleDb) {}

  /** The session, or null when none has the id. Never creates one. */
  async session(id: SessionId): Promise<Session | null> {
    const rows = await this.db.select().from(sessions).where(eq(sessions.id, id));
    return rows[0] ? restore(rows[0]) : null;
  }

  async predecessorOf(id: SessionId): Promise<Session | null> {
    const rows = await this.db
      .select()
      .from(sessions)
      .where(eq(sessions.supersededBy, id))
      .orderBy(desc(sessions.lastActiveAt))
      .limit(1);
    return rows[0] ? restore(rows[0]) : null;
  }

  async current(continuityKey: ContinuityKey, agentName: AgentName): Promise<Session | null> {
    const rows = await this.db
      .select()
      .from(sessions)
      .where(exactlyActive(continuityKey, agentName))
      .orderBy(desc(sessions.createdAt), desc(sessions.lastActiveAt))
      .limit(1);
    return rows[0] ? restore(rows[0]) : null;
  }

  /**
   * Adds a new session, with any turn it recorded before being added. Throws
   * `ActiveSessionExistsError` when the session
   * has a continuity key and a session is already active for it and exactly
   * this agent. Whoever opens sessions serializes `add` per continuity key, so
   * two opens at once cannot both pass the check.
   */
  async add(session: Session): Promise<void> {
    const state = session.snapshot();
    const pending = session.pendingChanges();
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
      // The row carries every fact the session holds, so a turn recorded
      // before the add needs only its checkpoint written beside it.
      tx.insert(sessions).values(toRow(state)).run();
      for (const checkpoint of pending.checkpoints) upsertCheckpoint(tx, checkpoint);
    });
    session.markSaved();
  }

  /**
   * Writes the facts the session changed since it was last saved, and the
   * checkpoints recorded since then. Only changed facts are written, so
   * two instances of one session that change different facts both keep their
   * writes. A completion is never undone, and the chat that has the session
   * is never written here. The session must have been added.
   */
  async save(session: Session): Promise<void> {
    const state = session.snapshot();
    const pending = session.pendingChanges();
    this.db.transaction((tx) => {
      const stored = tx
        .select({ id: sessions.id })
        .from(sessions)
        .where(eq(sessions.id, state.id))
        .get();
      if (!stored) throw new Error(`Session "${state.id}" was never added`);
      writeChanges(tx, state, pending.changes);
      for (const checkpoint of pending.checkpoints) upsertCheckpoint(tx, checkpoint);
    });
    session.markSaved();
  }

  /**
   * A reset, in one transaction: writes the retired session, completed, and
   * adds its successor from `retired.replace()`, with any turn the successor
   * recorded before the reset was written. Every other session still
   * active for the same continuity key and exact agent is completed too, so
   * the successor is the only one. The successor's row keeps the chat the
   * retired session's row names. Whoever resets serializes this per
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
    const retiredPending = retired.pendingChanges();
    const successorPending = successor.pendingChanges();
    this.db.transaction((tx) => {
      writeChanges(tx, retiredState, retiredPending.changes);
      for (const checkpoint of retiredPending.checkpoints) upsertCheckpoint(tx, checkpoint);
      if (retiredState.continuityKey !== null) {
        tx.update(sessions)
          .set({
            status: "completed",
            lastActiveAt: retiredState.lastActiveAt,
            supersededBy: successorState.id,
            supersededFor: retiredState.supersededFor,
          })
          .where(exactlyActive(retiredState.continuityKey, retiredState.agentName))
          .run();
      }
      // The successor stays in the chat that has the retired session. The chat
      // side owns that link and may change it after the reset.
      const chatId =
        tx
          .select({ chatId: sessions.chatId })
          .from(sessions)
          .where(eq(sessions.id, retiredState.id))
          .get()?.chatId ?? null;
      tx.insert(sessions)
        .values({ ...toRow(successorState), chatId })
        .run();
      for (const checkpoint of successorPending.checkpoints) upsertCheckpoint(tx, checkpoint);
    });
    retired.markSaved();
    successor.markSaved();
  }

  /** @deprecated The dashboard reads a turn's checkpoint only to hand it back
   *  to a fork. Goes when the session resolves its own fork point. */
  async deprecatedCheckpoint(sessionId: SessionId, turnId: string): Promise<TurnCheckpoint | null> {
    const rows = await this.db
      .select({
        sessionId: sessionTurnCheckpoints.sessionId,
        turnId: sessionTurnCheckpoints.turnId,
        provider: sessionTurnCheckpoints.provider,
        modelThreadId: sessionTurnCheckpoints.modelThreadId,
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

  /**
   * @deprecated Renames the agent of every session saved under an agent's
   * old bare name, such as `coding`, to its app-prefixed name, such as
   * `coding:coding`. Goes once no instance has a session saved under an old
   * name.
   */
  deprecatedRenameAgents(newNameOf: Readonly<Record<string, string>>): number {
    return this.db.transaction((tx) => {
      let renamed = 0;
      for (const [oldName, newName] of Object.entries(newNameOf)) {
        renamed += tx
          .update(sessions)
          .set({ agentName: newName })
          .where(eq(sessions.agentName, oldName))
          .run().changes;
      }
      return renamed;
    });
  }
}

function exactlyActive(continuityKey: ContinuityKey, agentName: AgentName) {
  return and(
    eq(sessions.channelThreadKey, continuityKey),
    eq(sessions.agentName, agentName),
    eq(sessions.status, "active"),
  );
}

function upsertCheckpoint(tx: DrizzleTx, checkpoint: TurnCheckpoint): void {
  const now = new Date();
  tx.insert(sessionTurnCheckpoints)
    .values({ ...checkpoint, createdAt: now })
    .onConflictDoUpdate({
      target: [sessionTurnCheckpoints.sessionId, sessionTurnCheckpoints.turnId],
      set: {
        provider: checkpoint.provider,
        modelThreadId: checkpoint.modelThreadId,
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
    modelThreadId: row.modelThreadId,
    model: row.model,
    reasoningEffort: row.reasoningEffort,
    workingDir: row.workingDir,
    setup: row.setup,
    supersededBy: row.supersededBy,
    supersededFor: row.supersededFor,
    createdAt: row.createdAt,
    lastActiveAt: row.lastActiveAt,
  });
}

/** Writes each changed fact as its own targeted update, as today's callers do. */
function writeChanges(
  tx: DrizzleTx,
  state: SessionState,
  changes: ReadonlySet<SessionChange>,
): void {
  const columns: Partial<SessionRow> = {};
  if (changes.has("turn")) {
    columns.provider = state.provider;
    columns.modelThreadId = state.modelThreadId;
    columns.model = state.model;
  }
  if (changes.has("reasoningEffort")) columns.reasoningEffort = state.reasoningEffort;
  if (changes.has("workingDir")) columns.workingDir = state.workingDir;
  if (changes.has("lastActiveAt")) columns.lastActiveAt = state.lastActiveAt;
  // A completion is final. A stale instance that still believes the session is
  // active never writes that belief back.
  if (changes.has("status") && state.status !== "active") {
    columns.status = state.status;
    if (state.supersededBy) {
      columns.supersededBy = state.supersededBy;
      columns.supersededFor = state.supersededFor;
    }
  }
  if (Object.keys(columns).length > 0) {
    tx.update(sessions).set(columns).where(eq(sessions.id, state.id)).run();
  }
}

function toRow(state: SessionState): SessionRow {
  return {
    id: state.id,
    agentName: state.agentName,
    channelThreadKey: state.continuityKey,
    // Which chat has the session is the chat side's to record.
    chatId: null,
    provider: state.provider,
    modelThreadId: state.modelThreadId,
    model: state.model,
    reasoningEffort: state.reasoningEffort,
    workingDir: state.workingDir,
    setup: state.setup,
    supersededBy: state.supersededBy,
    supersededFor: state.supersededFor,
    createdAt: state.createdAt,
    lastActiveAt: state.lastActiveAt,
    status: state.status,
  };
}
