import { eq, and, desc } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import { sessions, sessionTurnCheckpoints } from "../schema.js";
import type { DrizzleDb } from "../index.js";

export interface StoredSessionTurnCheckpoint {
  sessionId: string;
  turnId: string;
  provider: string;
  providerThreadId: string;
  checkpointId: string;
}

export class SessionsRepository {
  constructor(private db: DrizzleDb) {}

  async findByChannelThreadKey(channelThreadKey: string, agentName?: string) {
    const predicates = [
      eq(sessions.channelThreadKey, channelThreadKey),
      eq(sessions.status, "active"),
      ...(agentName ? [eq(sessions.agentName, agentName)] : []),
    ];
    const rows = await this.db
      .select()
      .from(sessions)
      .where(and(...predicates))
      .orderBy(desc(sessions.createdAt), desc(sessions.lastActiveAt));
    return rows[0] ?? null;
  }

  async findActiveByChannelThreadKey(channelThreadKey: string) {
    return await this.db
      .select()
      .from(sessions)
      .where(and(eq(sessions.channelThreadKey, channelThreadKey), eq(sessions.status, "active")))
      .orderBy(desc(sessions.createdAt), desc(sessions.lastActiveAt));
  }

  async findById(id: string, agentName?: string) {
    const predicates = [
      eq(sessions.id, id),
      ...(agentName ? [eq(sessions.agentName, agentName)] : []),
    ];
    const rows = await this.db
      .select()
      .from(sessions)
      .where(and(...predicates));
    return rows[0] ?? null;
  }

  async create(data: {
    id?: string;
    agentName: string;
    channelThreadKey?: string;
    status?: "active" | "completed" | "error";
  }) {
    const id = data.id ?? uuid();
    const now = new Date();
    await this.db.insert(sessions).values({
      id,
      agentName: data.agentName,
      channelThreadKey: data.channelThreadKey ?? null,
      createdAt: now,
      lastActiveAt: now,
      status: data.status ?? "active",
    });
    return id;
  }

  /** Complete every active row for an exact key and create its replacement in
   * one transaction. The caller serializes this key before entering. */
  async rotateProviderGeneration(input: {
    agentName: string;
    channelThreadKey: string;
    newSessionId: string;
  }): Promise<typeof sessions.$inferSelect> {
    return this.db.transaction((tx) => {
      const exactKey = and(
        eq(sessions.agentName, input.agentName),
        eq(sessions.channelThreadKey, input.channelThreadKey),
        eq(sessions.status, "active"),
      );
      const now = new Date();
      tx.update(sessions).set({ status: "completed", lastActiveAt: now }).where(exactKey).run();
      tx.insert(sessions)
        .values({
          id: input.newSessionId,
          agentName: input.agentName,
          channelThreadKey: input.channelThreadKey,
          provider: null,
          providerThreadId: null,
          model: null,
          createdAt: now,
          lastActiveAt: now,
          status: "active",
        })
        .run();
      const replacement = tx
        .select()
        .from(sessions)
        .where(eq(sessions.id, input.newSessionId))
        .get();
      if (!replacement) throw new Error("Failed to rotate provider session generation");
      return replacement;
    });
  }

  async touch(id: string) {
    await this.db.update(sessions).set({ lastActiveAt: new Date() }).where(eq(sessions.id, id));
  }

  async complete(id: string) {
    await this.db
      .update(sessions)
      .set({ status: "completed", lastActiveAt: new Date() })
      .where(eq(sessions.id, id));
  }

  async setProviderThreadId(id: string, providerThreadId: string): Promise<void> {
    await this.db.update(sessions).set({ providerThreadId }).where(eq(sessions.id, id));
  }

  /** Persist which provider owns this conversation (+ its thread id and the
   *  concrete model that ran — the session model pin) so a resumed
   *  session routes back to the same model. Always writes ALL columns together:
   *  when the new provider has not established a thread yet, `provider_thread_id`
   *  is CLEARED rather than left behind — otherwise a conversation marked as one
   *  provider could keep another provider's stale thread id and replay it on the
   *  next resume. `model` follows the same rule so a stale pin from a previous
   *  backend can never outlive the provider identity it belonged to. */
  async setProviderInfo(
    id: string,
    provider: string,
    providerThreadId?: string,
    model?: string,
  ): Promise<void> {
    await this.db
      .update(sessions)
      .set({ provider, providerThreadId: providerThreadId ?? null, model: model ?? null })
      .where(eq(sessions.id, id));
  }

  async setReasoningEffort(id: string, reasoningEffort: string): Promise<void> {
    await this.db.update(sessions).set({ reasoningEffort }).where(eq(sessions.id, id));
  }

  async setTurnCheckpoint(input: StoredSessionTurnCheckpoint): Promise<void> {
    await this.db
      .insert(sessionTurnCheckpoints)
      .values({ ...input, createdAt: new Date() })
      .onConflictDoUpdate({
        target: [sessionTurnCheckpoints.sessionId, sessionTurnCheckpoints.turnId],
        set: {
          provider: input.provider,
          providerThreadId: input.providerThreadId,
          checkpointId: input.checkpointId,
          createdAt: new Date(),
        },
      });
  }

  async getTurnCheckpoint(
    sessionId: string,
    turnId: string,
  ): Promise<StoredSessionTurnCheckpoint | null> {
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
}

export function createSessionsRepository(db: DrizzleDb) {
  return new SessionsRepository(db);
}
