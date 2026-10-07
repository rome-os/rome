import { and, asc, desc, eq, inArray, max } from "drizzle-orm";
import type { AppDbContext, DrizzleDb } from "@rome-os/app-runtime";
import type { FileChange } from "../../lib/changes.js";
import { createAppDbSchema } from "../schema.js";

export type RunKind = "dream" | "skill_review";
export type RunStatus = "running" | "completed" | "interrupted" | "failed";

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
      .where(and(eq(runs.kind, kind), eq(runs.status, "running")))
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
