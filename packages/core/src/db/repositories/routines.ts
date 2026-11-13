import { and, eq, inArray, sql } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import { routineRuns, routines } from "../schema.js";
import type { DrizzleDb } from "../index.js";
import { actorOfOwner } from "../../access/owner-actor.js";
import {
  currentSessionActor,
  guardianActor,
  type SessionActor,
} from "../../access/session-actor.js";
import { actionExecutionContext } from "../../apps/actions/context.js";
import {
  ACTIVE_ROUTINE_RUN_STATUSES,
  type DeleteRoutineResult,
  type Routine,
  type Trigger,
} from "../../routines/types.js";

type RoutineRow = typeof routines.$inferSelect;

export function toRoutine(row: RoutineRow): Routine {
  return {
    id: row.id,
    name: row.name,
    key: row.key ?? undefined,
    managedBy: row.managedBy ?? undefined,
    enabled: row.enabled ?? true,
    trigger: row.trigger as Trigger,
    actionName: row.actionName,
    args: (row.args ?? {}) as Record<string, unknown>,
    ...(row.keepTriggerPayload === false ? { keepTriggerPayload: false } : {}),
    createdAt: row.createdAt,
    lastFiredAt: row.lastFiredAt ?? undefined,
    nextRunAt: row.nextRunAt ?? undefined,
  };
}

/**
 * A routine row as the dashboard's `/routines` routes answer it. Who created
 * it stays in core: only the routine engine reads it ({@link RoutinesRepository.creatorOf}).
 */
export function publicRoutineRow<T extends RoutineRow>(row: T): Omit<T, "createdBy"> {
  const { createdBy: _createdBy, ...rest } = row;
  return rest;
}

/**
 * Who a routine its creator names for a person serves, by owner key
 * ("guardian", "visitor:<account>"), such as a Concierge's digest.
 */
export interface RoutineOwner {
  owner: string;
}

/**
 * Who a routine created now acts for. One that names its person, or an
 * owner (as {@link RoutineOwner}), acts for them. An app's routine is the
 * guardian's. Otherwise the person of the action or request creating it; an
 * action that acts for no one (a turn with more than one person's input)
 * makes it act for no one. Core work outside any action, with no person, is
 * the guardian's.
 */
export async function routineCreator(
  db: DrizzleDb,
  given: { createdBy?: SessionActor | RoutineOwner; managedBy?: string },
): Promise<SessionActor | null> {
  if (given.createdBy && "owner" in given.createdBy) {
    return (await actorOfOwner(db, given.createdBy.owner)) ?? { kind: "anonymous" };
  }
  if (given.createdBy !== undefined) return given.createdBy;
  if (given.managedBy) return (await guardianActor(db)) ?? null;
  const store = actionExecutionContext.getStore();
  if (store) return store.actor ?? { kind: "anonymous" };
  return (await currentSessionActor()) ?? (await guardianActor(db)) ?? null;
}

/** The actions whose args name the chat they send into, and the arg that names it. */
const CHAT_ARG_OF_ACTION: Record<string, string> = {
  resume_session: "threadId",
  send_message: "threadId",
  send_user_message: "sessionId",
};

/**
 * The chat a routine created now works for: the webchat chat whose turn
 * creates it, else the chat its args send into (`threadId` of
 * `resume_session` and `send_message`, `sessionId` of `send_user_message`).
 * Null when neither names one. Migration 0134 fills older rows by the args rule.
 */
export function routineChatOf(actionName: string, args: Record<string, unknown>): string | null {
  const context = actionExecutionContext.getStore()?.channelContext;
  if (context?.channel === "webchat" && context.threadId) return context.threadId;
  const arg = CHAT_ARG_OF_ACTION[actionName.replace(/^system:/, "")];
  const value = arg ? args[arg] : undefined;
  return typeof value === "string" && value ? value : null;
}

export class RoutinesRepository {
  constructor(private db: DrizzleDb) {}

  async findAll() {
    const rows = await this.db.select().from(routines);
    return rows;
  }

  async findEnabled() {
    const rows = await this.db.select().from(routines).where(eq(routines.enabled, true));
    return rows;
  }

  async findById(id: string) {
    const rows = await this.db.select().from(routines).where(eq(routines.id, id));
    return rows[0] ?? null;
  }

  /**
   * The person a routine's fires act for, as stored: who created it, or the
   * guardian for one no person made, or `anonymous` for one made in work that
   * acts for no one. Null for a row from before the record, whose fires act
   * for its chat's owner. Undefined when no such routine exists.
   */
  async creatorOf(id: string): Promise<SessionActor | null | undefined> {
    const rows = await this.db
      .select({ createdBy: routines.createdBy })
      .from(routines)
      .where(eq(routines.id, id));
    if (rows.length === 0) return undefined;
    return (rows[0].createdBy as SessionActor | null) ?? null;
  }

  /** The trigger type shared by every routine named `name`. Names are not
   * unique, so this is null when the routines disagree or none has the name. */
  async findTriggerTypeByName(name: string): Promise<string | null> {
    const rows = await this.db
      .select({ trigger: routines.trigger })
      .from(routines)
      .where(eq(routines.name, name));
    const types = new Set(rows.map((row) => (row.trigger as Trigger).type));
    return types.size === 1 ? [...types][0] : null;
  }

  /** Look up a routine by its caller-assigned `key`. Used by create_routine to
   * reject a duplicate key before insert (the column's UNIQUE constraint is the
   * authoritative backstop). Returns null when the key is unused. */
  /** The routines that work for chat `chatId`, as stored rows. */
  async findByChat(chatId: string) {
    return this.db.select().from(routines).where(eq(routines.chatId, chatId));
  }

  async findByKey(key: string): Promise<Routine | null> {
    const rows = await this.db.select().from(routines).where(eq(routines.key, key));
    return rows[0] ? toRoutine(rows[0]) : null;
  }

  /** Domain-typed read for app actions. `findAll` returns raw rows (trigger as
   * `unknown`, nullable timestamps) for in-process callers that map them with
   * `toRoutine`; this returns `Routine` so the published SDK boundary speaks
   * the domain type instead of leaking drizzle row shapes. */
  async listRoutines(): Promise<Routine[]> {
    const rows = await this.findAll();
    return rows.map(toRoutine);
  }

  /** Delete a routine only if it has no in-flight runs. The active-run count
   * and the delete run in one transaction so a run can't start (or finish)
   * between check and delete — without it, a concurrent fire could be counted
   * as absent and then orphaned by the delete (TOCTOU). Returns which branch
   * was taken so the caller can report it without a second, racy lookup.
   *
   * A routine with `managedBy` set is owned by an app and can only be deleted by
   * that app: pass `actor` = the managing app's id to authorize it. A user-facing
   * delete (dashboard, or the agent's delete_routine) leaves `actor` unset and is
   * refused with `{ status: "managed" }` — the app keeps sole control so a user
   * can't prune a routine the app recreates on its next sync. */
  async deleteIfNoActiveRuns(id: string, actor?: string): Promise<DeleteRoutineResult> {
    return this.db.transaction((tx): DeleteRoutineResult => {
      const routine = tx
        .select({ name: routines.name, managedBy: routines.managedBy })
        .from(routines)
        .where(eq(routines.id, id))
        .get();
      if (!routine) return { status: "not-found" };

      // Refuse unless the caller is the owning app. Checked before the active-run
      // count so a managed routine reports "managed" regardless of run state.
      if (routine.managedBy && routine.managedBy !== actor) {
        return { status: "managed", managedBy: routine.managedBy };
      }

      const active = tx
        .select({ count: sql<number>`count(*)` })
        .from(routineRuns)
        .where(
          and(
            eq(routineRuns.routineId, id),
            inArray(routineRuns.status, [...ACTIVE_ROUTINE_RUN_STATUSES]),
          ),
        )
        .get();
      const activeRuns = Number(active?.count ?? 0);
      if (activeRuns > 0) return { status: "active-runs", activeRuns };

      // routine_runs.routineId is a non-cascading FK to routines.id, so the
      // (terminal) run history must go first or the routine delete violates it.
      // Same transaction → the history can't outlive the routine, nor vice versa.
      tx.delete(routineRuns).where(eq(routineRuns.routineId, id)).run();
      tx.delete(routines).where(eq(routines.id, id)).run();
      return { status: "deleted", name: routine.name };
    });
  }

  async create(data: {
    name: string;
    key?: string;
    managedBy?: string;
    trigger: Trigger;
    actionName: string;
    args: Record<string, unknown>;
    enabled?: boolean;
    nextRunAt?: Date;
    keepTriggerPayload?: boolean;
    /** Who its fires act for; absent, {@link routineCreator} decides. */
    createdBy?: SessionActor | RoutineOwner;
    /** The chat it works for; absent, {@link routineChatOf} decides. Null for none. */
    chatId?: string | null;
  }): Promise<string> {
    const id = uuid();
    const now = new Date();
    const createdBy = await routineCreator(this.db, data);
    await this.db.insert(routines).values({
      id,
      name: data.name,
      key: data.key ?? null,
      managedBy: data.managedBy ?? null,
      enabled: data.enabled ?? true,
      trigger: data.trigger as unknown,
      actionName: data.actionName,
      args: data.args as unknown,
      keepTriggerPayload: data.keepTriggerPayload ?? true,
      createdBy,
      chatId: data.chatId === undefined ? routineChatOf(data.actionName, data.args) : data.chatId,
      createdAt: now,
      lastFiredAt: null,
      nextRunAt: data.nextRunAt ?? null,
    });
    return id;
  }

  async update(
    id: string,
    data: Partial<{
      name: string;
      enabled: boolean;
      trigger: Trigger;
      actionName: string;
      args: Record<string, unknown>;
      nextRunAt: Date | null;
      keepTriggerPayload: boolean;
    }>,
  ) {
    const values: Record<string, unknown> = {};
    if (data.name !== undefined) values.name = data.name;
    if (data.enabled !== undefined) values.enabled = data.enabled;
    if (data.trigger !== undefined) values.trigger = data.trigger;
    if (data.actionName !== undefined) values.actionName = data.actionName;
    if (data.args !== undefined) values.args = data.args;
    if (data.nextRunAt !== undefined) values.nextRunAt = data.nextRunAt;
    if (data.keepTriggerPayload !== undefined) values.keepTriggerPayload = data.keepTriggerPayload;

    await this.db.update(routines).set(values).where(eq(routines.id, id));
  }

  async updateLastFired(id: string, lastFiredAt: Date) {
    await this.db.update(routines).set({ lastFiredAt }).where(eq(routines.id, id));
  }

  async updateNextRun(id: string, nextRunAt: Date | null) {
    await this.db.update(routines).set({ nextRunAt }).where(eq(routines.id, id));
  }
}
