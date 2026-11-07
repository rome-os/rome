// The Drizzle adapter of the Sessions repository port, over `sessions` and
// `session_turn_checkpoints`, reading a recorded chat from `rome_sessions`. Port: agent/domain/session-repository.ts.
// Aggregate: agent/domain/session.ts.

import type { RomeSessionType } from "@rome-os/app-runtime";
import { and, desc, eq, isNull } from "drizzle-orm";
import { resolveArtifactId, type ArtifactIdentityContext } from "../../apps/artifact-id.js";
import type { DrizzleDb, DrizzleTx } from "../../db/index.js";
import { romeSessions, sessions, sessionTurnCheckpoints } from "../../db/schema.js";
import { sessionKindOf } from "../../db/session-kind.js";
import {
  Session,
  type AgentName,
  type ContinuityKey,
  type SessionChange,
  type SessionId,
  type SessionState,
  type TurnCheckpoint,
} from "../domain/session.js";
import {
  ActiveSessionExistsError,
  type RecordedChat,
  type SessionRepository,
} from "../domain/session-repository.js";

type SessionRow = typeof sessions.$inferSelect;

/**
 * The Sessions repository over SQLite through Drizzle. It is the only code
 * that touches `sessions` and `session_turn_checkpoints`. The agent also
 * matches under its legacy names in `current`, through {@link deprecatedSameAgent}.
 */
export class DrizzleSessionRepository implements SessionRepository {
  constructor(
    private readonly db: DrizzleDb,
    private readonly identity: ArtifactIdentityContext,
  ) {}

  /** The session, or null when none has the id. Never creates one. */
  async session(id: SessionId): Promise<Session | null> {
    const rows = await this.db.select().from(sessions).where(eq(sessions.id, id));
    return rows[0] ? restore(rows[0]) : null;
  }

  async current(continuityKey: ContinuityKey, agentName: AgentName): Promise<Session | null> {
    const rows = await this.db
      .select()
      .from(sessions)
      .where(and(eq(sessions.channelThreadKey, continuityKey), eq(sessions.status, "active")))
      .orderBy(desc(sessions.createdAt), desc(sessions.lastActiveAt));
    const row = rows.find((candidate) => this.deprecatedSameAgent(candidate.agentName, agentName));
    return row ? restore(row) : null;
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
   * writes. A chat is recorded only on a session that still has none, and a
   * completion is never undone. The session must have been added.
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
   * the successor is the only one. A successor that named no chat inherits
   * the retired session's stored chat. Whoever resets serializes this per
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
          .set({ status: "completed", lastActiveAt: retiredState.lastActiveAt })
          .where(exactlyActive(retiredState.continuityKey, retiredState.agentName))
          .run();
      }
      // The inherited chat is the row's, not the instance's, as today's reset
      // reads it: the instance can predate the chat's recording.
      if (successorState.chatId === null) {
        successorState.chatId =
          tx
            .select({ chatId: sessions.chatId })
            .from(sessions)
            .where(eq(sessions.id, retiredState.id))
            .get()?.chatId ?? null;
      }
      tx.insert(sessions).values(toRow(successorState)).run();
      for (const checkpoint of successorPending.checkpoints) upsertCheckpoint(tx, checkpoint);
    });
    retired.markSaved();
    successor.markSaved();
    if (successorState.chatId !== null && successor.deprecatedChatId === null) {
      successor.deprecatedInheritChat(successorState.chatId);
    }
  }

  async recordedChat(session: Session): Promise<RecordedChat | null> {
    const chatId = session.deprecatedChatId;
    if (!chatId) return null;
    const [row] = await this.db
      .select({
        id: romeSessions.id,
        name: romeSessions.name,
        type: romeSessions.type,
        chatPlatform: romeSessions.chatPlatform,
      })
      .from(romeSessions)
      .where(eq(romeSessions.id, chatId));
    if (!row) return null;
    return { id: row.id, name: row.name, type: sessionKindOf(row) as RomeSessionType };
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

  /** @deprecated Matches an agent under its legacy names, which is identity
   *  resolution Sessions should not do. Goes when agent names are canonical
   *  before they reach Sessions, and `current` compares them as strings. */
  private deprecatedSameAgent(storedName: string, requestedName: string): boolean {
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
    createdAt: row.createdAt,
    lastActiveAt: row.lastActiveAt,
    chatId: row.chatId,
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
  if (changes.has("status") && state.status !== "active") columns.status = state.status;
  if (Object.keys(columns).length > 0) {
    tx.update(sessions).set(columns).where(eq(sessions.id, state.id)).run();
  }
  if (changes.has("chat") && state.chatId !== null) {
    tx.update(sessions)
      .set({ chatId: state.chatId })
      .where(and(eq(sessions.id, state.id), isNull(sessions.chatId)))
      .run();
  }
}

function toRow(state: SessionState): SessionRow {
  return {
    id: state.id,
    agentName: state.agentName,
    channelThreadKey: state.continuityKey,
    chatId: state.chatId,
    provider: state.provider,
    modelThreadId: state.modelThreadId,
    model: state.model,
    reasoningEffort: state.reasoningEffort,
    workingDir: state.workingDir,
    createdAt: state.createdAt,
    lastActiveAt: state.lastActiveAt,
    status: state.status,
  };
}
