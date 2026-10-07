import { and, asc, desc, eq, inArray, max, sql } from "drizzle-orm";
import type { AppDbContext, DrizzleDb } from "@rome-os/app-runtime";
import type { FileChange } from "../../lib/changes.js";
import { STALE_RUN_MS } from "../../lib/run-view.js";
import { createAppDbSchema } from "../schema.js";

export type RunKind = "dream" | "skill_review";
/** `queued`: reserved by the page and not yet claimed by an action. */
export type RunStatus = "queued" | "running" | "completed" | "interrupted" | "failed";

export interface Run {
  id: string;
  kind: RunKind;
  status: RunStatus;
  windowHours: number | null;
  reviewedSessionId: string | null;
  reviewedSessionName: string | null;
  summary: string | null;
  error: string | null;
  startedAt: Date;
  finishedAt: Date | null;
}

export interface RunStart {
  kind: RunKind;
  windowHours?: number;
  reviewedSessionId?: string;
  reviewedSessionName?: string | null;
}

export class RunsRepository {
  private readonly tables;

  constructor(
    private readonly db: DrizzleDb,
    tablePrefix: string,
  ) {
    this.tables = createAppDbSchema(tablePrefix);
  }

  start(input: RunStart): string {
    const id = crypto.randomUUID();
    this.db
      .insert(this.tables.runs)
      .values({
        id,
        kind: input.kind,
        status: "running",
        windowHours: input.windowHours ?? null,
        reviewedSessionId: input.reviewedSessionId ?? null,
        reviewedSessionName: input.reviewedSessionName ?? null,
        startedAt: new Date(),
      })
      .run();
    return id;
  }

  /**
   * Starts a dream unless one is already running, as one statement so two
   * entry points (the page and the nightly routine) cannot both win. A run
   * left active past the stale window does not block. The page reserves it
   * `queued` for the action it dispatches to `claim`; an action that runs
   * straight away reserves it `running`.
   */
  reserveDream(
    windowHours: number,
    status: "queued" | "running",
  ): { id: string; reserved: boolean } {
    const { runs } = this.tables;
    const id = crypto.randomUUID();
    const now = Date.now();
    const result = this.db.run(sql`
      INSERT INTO ${runs} (id, kind, status, window_hours, started_at)
      SELECT ${id}, 'dream', ${status}, ${windowHours}, ${now}
      WHERE NOT EXISTS (
        SELECT 1 FROM ${runs}
        WHERE kind = 'dream' AND status IN ('queued', 'running')
          AND started_at > ${now - STALE_RUN_MS}
      )
    `) as { changes: number };
    if (result.changes > 0) return { id, reserved: true };
    const running = this.latestRunning("dream");
    if (!running) throw new Error("dream reservation lost without a running dream");
    return { id: running.id, reserved: false };
  }

  /** Moves a queued dream to running. Only one caller can win it. */
  claim(id: string): boolean {
    const { runs } = this.tables;
    const result = this.db
      .update(runs)
      .set({ status: "running" })
      .where(and(eq(runs.id, id), eq(runs.kind, "dream"), eq(runs.status, "queued")))
      .run() as { changes: number };
    return result.changes > 0;
  }

  finish(
    id: string,
    outcome:
      | { status: "completed" | "interrupted"; summary: string }
      | { status: "failed"; error: string },
  ): void {
    this.db
      .update(this.tables.runs)
      .set({
        status: outcome.status,
        summary: outcome.status === "failed" ? null : outcome.summary,
        error: outcome.status === "failed" ? outcome.error : null,
        finishedAt: new Date(),
      })
      .where(eq(this.tables.runs.id, id))
      .run();
  }

  addChanges(runId: string, changes: FileChange[]): void {
    if (changes.length === 0) return;
    const { runChanges } = this.tables;
    const last = this.db
      .select({ seq: max(runChanges.seq) })
      .from(runChanges)
      .where(eq(runChanges.runId, runId))
      .get();
    let seq = (last?.seq ?? -1) + 1;
    const createdAt = new Date();
    this.db
      .insert(runChanges)
      .values(
        changes.map((change) => ({
          id: crypto.randomUUID(),
          runId,
          seq: seq++,
          op: change.op,
          path: change.path,
          content: change.content,
          previous: change.previous,
          truncated: change.truncated,
          createdAt,
        })),
      )
      .run();
  }

  byId(id: string): Run | undefined {
    return this.db.select().from(this.tables.runs).where(eq(this.tables.runs.id, id)).get() as
      | Run
      | undefined;
  }

  listRecent(options: { kind?: RunKind; limit: number }): Run[] {
    const { runs } = this.tables;
    return this.db
      .select()
      .from(runs)
      .where(options.kind ? eq(runs.kind, options.kind) : undefined)
      .orderBy(desc(runs.startedAt))
      .limit(options.limit)
      .all() as Run[];
  }

  latestRunning(kind: RunKind): Run | undefined {
    const { runs } = this.tables;
    return this.db
      .select()
      .from(runs)
      .where(and(eq(runs.kind, kind), inArray(runs.status, ["queued", "running"])))
      .orderBy(desc(runs.startedAt))
      .limit(1)
      .get() as Run | undefined;
  }

  changes(runId: string): FileChange[] {
    const { runChanges } = this.tables;
    return this.db
      .select({
        op: runChanges.op,
        path: runChanges.path,
        content: runChanges.content,
        previous: runChanges.previous,
        truncated: runChanges.truncated,
      })
      .from(runChanges)
      .where(eq(runChanges.runId, runId))
      .orderBy(asc(runChanges.seq))
      .all() as FileChange[];
  }

  /** Each run's changed paths and ops, without the content, for list rows. */
  changePaths(runIds: string[]): Map<string, Array<Pick<FileChange, "op" | "path">>> {
    const byRun = new Map<string, Array<Pick<FileChange, "op" | "path">>>();
    if (runIds.length === 0) return byRun;
    const { runChanges } = this.tables;
    const rows = this.db
      .select({ runId: runChanges.runId, op: runChanges.op, path: runChanges.path })
      .from(runChanges)
      .where(inArray(runChanges.runId, runIds))
      .orderBy(asc(runChanges.runId), asc(runChanges.seq))
      .all() as Array<{ runId: string; op: FileChange["op"]; path: string }>;
    for (const { runId, ...change } of rows) {
      const list = byRun.get(runId) ?? [];
      list.push(change);
      byRun.set(runId, list);
    }
    return byRun;
  }
}

export function createRunsRepository(ctx: AppDbContext): RunsRepository {
  return new RunsRepository(ctx.connection, ctx.tablePrefix);
}
