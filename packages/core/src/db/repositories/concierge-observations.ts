import { randomUUID } from "node:crypto";
import { and, asc, eq, lt } from "drizzle-orm";
import type { DrizzleDb } from "../index.js";
import { conciergeObservations } from "../schema.js";

type Row = typeof conciergeObservations.$inferSelect;

export type ObservationKind = Row["kind"];
export type ObservationSource = Row["source"];
export type ObservationBasis = Row["basis"];
export type ObservationStatus = Row["status"];
export type ObservationOutcomeKind = "told" | "adopted" | "ignored" | "muted";

/** One time an observation was told, or what came of it. */
export interface ObservationOutcome {
  outcome: ObservationOutcomeKind;
  /** Epoch milliseconds. */
  at: number;
}

export interface Observation {
  id: string;
  ownerKey: string;
  topicKey: string;
  kind: ObservationKind;
  source: ObservationSource;
  basis: ObservationBasis;
  confidence: number;
  status: ObservationStatus;
  summary: string;
  taskId: string | null;
  dueAt: Date | null;
  expiresAt: Date;
  outcomes: ObservationOutcome[];
  toldCount: number;
  ignoredCount: number;
  lastToldAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** What the patrol writes of an observation; the rest is kept as stored. */
export type ObservationWrite = Pick<
  Observation,
  | "topicKey"
  | "kind"
  | "source"
  | "basis"
  | "confidence"
  | "status"
  | "summary"
  | "taskId"
  | "dueAt"
  | "expiresAt"
>;

const OUTCOMES = new Set<ObservationOutcomeKind>(["told", "adopted", "ignored", "muted"]);

function outcomesOf(raw: string): ObservationOutcome[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item) => {
      const { outcome, at } = (item ?? {}) as { outcome?: unknown; at?: unknown };
      return typeof outcome === "string" &&
        OUTCOMES.has(outcome as ObservationOutcomeKind) &&
        typeof at === "number"
        ? [{ outcome: outcome as ObservationOutcomeKind, at }]
        : [];
    });
  } catch {
    return [];
  }
}

const toObservation = (row: Row): Observation => ({ ...row, outcomes: outcomesOf(row.outcomes) });

/** The patrol's observations of each owner, one per topic. */
export class ConciergeObservationsRepository {
  constructor(private db: DrizzleDb) {}

  /** Every observation of `owner`, oldest first. */
  async list(owner = "guardian"): Promise<Observation[]> {
    const rows = await this.db
      .select()
      .from(conciergeObservations)
      .where(eq(conciergeObservations.ownerKey, owner))
      .orderBy(asc(conciergeObservations.createdAt));
    return rows.map(toObservation);
  }

  async find(topicKey: string, owner = "guardian"): Promise<Observation | null> {
    const [row] = await this.db
      .select()
      .from(conciergeObservations)
      .where(
        and(
          eq(conciergeObservations.ownerKey, owner),
          eq(conciergeObservations.topicKey, topicKey),
        ),
      );
    return row ? toObservation(row) : null;
  }

  /**
   * Writes an observation by its topic: a new topic is made, a known one
   * changes the fields given and keeps its outcome history.
   */
  async upsert(write: ObservationWrite, at: Date, owner = "guardian"): Promise<Observation> {
    const [row] = await this.db
      .insert(conciergeObservations)
      .values({
        id: randomUUID(),
        ownerKey: owner,
        ...write,
        createdAt: at,
        updatedAt: at,
      })
      .onConflictDoUpdate({
        target: [conciergeObservations.ownerKey, conciergeObservations.topicKey],
        set: { ...write, updatedAt: at },
      })
      .returning();
    if (!row) throw new Error(`observation ${write.topicKey} was not written`);
    return toObservation(row);
  }

  /** Keeps what came of telling an observation, and its counts. */
  async recordOutcome(
    topicKey: string,
    outcome: ObservationOutcome,
    owner = "guardian",
  ): Promise<Observation | null> {
    const found = await this.find(topicKey, owner);
    if (!found) return null;
    const outcomes = [...found.outcomes, outcome];
    const [row] = await this.db
      .update(conciergeObservations)
      .set({
        outcomes: JSON.stringify(outcomes),
        ...(outcome.outcome === "told"
          ? { toldCount: found.toldCount + 1, lastToldAt: new Date(outcome.at) }
          : {}),
        ...(outcome.outcome === "ignored" ? { ignoredCount: found.ignoredCount + 1 } : {}),
        updatedAt: new Date(outcome.at),
      })
      .where(eq(conciergeObservations.id, found.id))
      .returning();
    return row ? toObservation(row) : null;
  }

  /** Sets the status of `owner`'s observations whose expiry passed to expired. Answers how many. */
  async expire(now: Date, owner = "guardian"): Promise<number> {
    const rows = await this.db
      .update(conciergeObservations)
      .set({ status: "expired", updatedAt: now })
      .where(
        and(
          eq(conciergeObservations.ownerKey, owner),
          eq(conciergeObservations.status, "open"),
          lt(conciergeObservations.expiresAt, now),
        ),
      )
      .returning({ id: conciergeObservations.id });
    return rows.length;
  }

  /** Deletes observations that ended (done or expired) before `before`. */
  async prune(before: Date, owner = "guardian"): Promise<void> {
    const ended = (await this.list(owner)).filter(
      (observation) => observation.status !== "open" && observation.updatedAt < before,
    );
    for (const observation of ended) {
      await this.db
        .delete(conciergeObservations)
        .where(eq(conciergeObservations.id, observation.id));
    }
  }
}
