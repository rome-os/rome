import { asc, eq } from "drizzle-orm";
import type { AppDbContext, DrizzleDb } from "@rome-os/app-runtime";
import { type Fact, type FactKind, type NewFact, isWorkerTerminalKind } from "../../lib/facts.js";
import { createAppDbSchema } from "../schema.js";

/**
 * The ledger, as the only way into the `facts` table. It appends and it reads;
 * there is no update and no delete, because a fact that could be rewritten
 * would stop being a fact.
 */
export class LedgerRepository {
  private readonly tables;

  constructor(
    private readonly db: DrizzleDb,
    tablePrefix: string,
  ) {
    this.tables = createAppDbSchema(tablePrefix);
  }

  /**
   * Whether the ledger can be read right now. A pass that gets `false` ends
   * without writing anything. With SQLite on the same host this is nearly
   * always true, so the check is deliberately one cheap row.
   */
  reachable(): boolean {
    try {
      this.db.select().from(this.tables.facts).limit(1).all();
      return true;
    } catch {
      return false;
    }
  }

  append(fact: NewFact): Fact {
    const id = crypto.randomUUID();
    const createdAt = new Date();
    const row = this.db
      .insert(this.tables.facts)
      .values({
        id,
        taskId: fact.taskId,
        kind: fact.kind,
        by: fact.by,
        source: fact.source,
        payload: JSON.stringify(fact.payload),
        createdAt,
      })
      .returning()
      .get();
    return toFact(row);
  }

  /**
   * Append a worker's own outcome, unless the runtime already closed that
   * worker. The runtime records a stop as a Lost fact, and the stopped worker
   * keeps running and eventually reports back; without this guard that late
   * reply would move a task the runtime has already moved on from.
   */
  appendWorkerOutcome(fact: NewFact & { payload: { workerId: string } }): Fact | undefined {
    const closed = this.factsFor(fact.taskId).some(
      (existing) =>
        isWorkerTerminalKind(existing.kind) &&
        (existing.payload as { workerId?: string }).workerId === fact.payload.workerId,
    );
    if (closed) return undefined;
    return this.append(fact);
  }

  all(): Fact[] {
    return this.db
      .select()
      .from(this.tables.facts)
      .orderBy(asc(this.tables.facts.seq))
      .all()
      .map(toFact);
  }

  factsFor(taskId: string): Fact[] {
    return this.db
      .select()
      .from(this.tables.facts)
      .where(eq(this.tables.facts.taskId, taskId))
      .orderBy(asc(this.tables.facts.seq))
      .all()
      .map(toFact);
  }
}

type FactRow = {
  seq: number;
  id: string;
  taskId: string;
  kind: string;
  by: string;
  source: string | null;
  payload: string;
  createdAt: Date;
};

function toFact(row: FactRow): Fact {
  return {
    seq: row.seq,
    id: row.id,
    taskId: row.taskId,
    kind: row.kind as FactKind,
    by: row.by,
    source: row.source ?? undefined,
    payload: JSON.parse(row.payload),
    createdAt: row.createdAt,
  } as Fact;
}

export function createLedgerRepository(ctx: AppDbContext): LedgerRepository {
  return new LedgerRepository(ctx.connection, ctx.tablePrefix);
}
