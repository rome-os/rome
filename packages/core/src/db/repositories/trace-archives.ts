import type Database from "better-sqlite3";
import { eq, sql } from "drizzle-orm";
import type { DrizzleDb } from "../index.js";
import { ARCHIVE_KEEP_BLOCK_TYPES, romeTraceArchives } from "../schema.js";
import { traceSessionActivitySql } from "./trace-activity.js";
import {
  isSessionTraceArchived,
  sessionTraceCutoff,
  TRACE_ACTIVITY_ROLES,
} from "../../webchat/trace-retention.js";

export type TraceArchive = typeof romeTraceArchives.$inferSelect;
export interface ArchiveManifest {
  kind: "header";
  schemaVersion: 1;
  accountId?: string;
  instanceId?: string;
  sessionId: string;
  archiveId: string;
  createdAt: string;
  session: Record<string, unknown>;
  messageIds: string[];
  blockCount: number;
  /** A snapshot boundary, so even an append to an exported message cannot be pruned. */
  messages: { id: string; maxSeq: number; blockCount: number }[];
}

export class TraceArchivesRepository {
  readonly sqlite: Database.Database;
  constructor(private readonly db: DrizzleDb) {
    this.sqlite = (db as DrizzleDb & { $client: Database.Database }).$client;
  }

  candidates(now = new Date()) {
    return this.db.all<{ sessionId: string; lastMessageAt: number }>(sql`
      SELECT * FROM (${traceSessionActivitySql()}) activity
      WHERE lastMessageAt <= ${Math.floor(sessionTraceCutoff(now).getTime() / 1000)}
        AND NOT EXISTS (SELECT 1 FROM rome_trace_archive_deletes d WHERE d.session_id = activity.sessionId)
        AND EXISTS (SELECT 1 FROM rome_agent_messages m
          WHERE m.session_id = activity.sessionId AND m.role = 'trace' AND m.trace_archive_id IS NULL)
      ORDER BY lastMessageAt, sessionId
    `);
  }

  listPending(): TraceArchive[] {
    return this.db
      .select()
      .from(romeTraceArchives)
      .where(sql`${romeTraceArchives.status} IN ('exported', 'stored', 'discarded')
        AND NOT EXISTS (SELECT 1 FROM rome_trace_archive_deletes d WHERE d.session_id = ${romeTraceArchives.sessionId})`)
      .all();
  }
  hasRetainedArchives(sessionId: string): boolean {
    return Boolean(
      this.sqlite
        .prepare(
          "SELECT 1 FROM rome_trace_archives WHERE session_id = ? AND status IN ('stored', 'pruned') LIMIT 1",
        )
        .get(sessionId),
    );
  }
  get(id: string): TraceArchive | undefined {
    return this.db.select().from(romeTraceArchives).where(eq(romeTraceArchives.id, id)).get();
  }
  insert(row: typeof romeTraceArchives.$inferInsert) {
    this.db.insert(romeTraceArchives).values(row).run();
  }
  update(id: string, values: Partial<typeof romeTraceArchives.$inferInsert>) {
    this.db.update(romeTraceArchives).set(values).where(eq(romeTraceArchives.id, id)).run();
  }
  remove(id: string) {
    this.db.delete(romeTraceArchives).where(eq(romeTraceArchives.id, id)).run();
  }
  hasRemoteArchives(sessionId: string): boolean {
    return Boolean(
      this.sqlite
        .prepare(
          "SELECT 1 FROM rome_trace_archives WHERE session_id = ? AND location LIKE 's3:%' LIMIT 1",
        )
        .get(sessionId),
    );
  }
  pendingBytes(): number {
    return (
      this.sqlite
        .prepare(
          "SELECT coalesce(sum(bytes), 0) AS bytes FROM rome_trace_archives WHERE status = 'exported'",
        )
        .get() as { bytes: number }
    ).bytes;
  }

  /** Synchronous transaction: activity cannot change between the check and the turn markers. */
  mark(id: string, manifest: ArchiveManifest, now = new Date(), running = false): boolean {
    return this.db.transaction(() => {
      const row = this.get(id);
      if (!row || row.status !== "stored") return false;
      const alreadyMarked = this.sqlite
        .prepare("SELECT 1 FROM rome_agent_messages WHERE trace_archive_id = ? LIMIT 1")
        .get(id);
      // Once marked, pruning must finish even if new activity arrives after a crash.
      if (alreadyMarked) return true;
      const activity = this.db.all<{ lastMessageAt: number }>(
        traceSessionActivitySql([row.sessionId]),
      )[0];
      const deleted = this.sqlite
        .prepare("SELECT 1 FROM rome_trace_archive_deletes WHERE session_id = ?")
        .get(row.sessionId);
      if (
        running ||
        deleted ||
        !activity ||
        !isSessionTraceArchived(new Date(activity.lastMessageAt * 1000), sessionTraceCutoff(now))
      ) {
        this.update(id, { status: "discarded" });
        return false;
      }
      const find =
        this.sqlite.prepare(`SELECT m.trace_archive_id AS archiveId, count(b.seq) AS count, coalesce(max(b.seq), -1) AS maxSeq
        FROM rome_agent_messages m LEFT JOIN rome_agent_trace_blocks b ON b.message_id = m.id
        WHERE m.id = ? AND m.session_id = ? GROUP BY m.id`);
      for (const message of manifest.messages) {
        const current = find.get(message.id, row.sessionId) as
          | { archiveId: string | null; count: number; maxSeq: number }
          | undefined;
        if (
          !current ||
          current.archiveId ||
          current.count !== message.blockCount ||
          current.maxSeq !== message.maxSeq
        ) {
          this.update(id, { status: "discarded" });
          return false;
        }
      }
      const mark = this.sqlite.prepare(
        "UPDATE rome_agent_messages SET trace_archive_id = ? WHERE id = ? AND session_id = ? AND trace_archive_id IS NULL",
      );
      for (const message of manifest.messages) mark.run(id, message.id, row.sessionId);
      return true;
    });
  }

  /** Bounds each synchronous delete by 200 rows and ~8 MiB (one oversized row is indivisible). */
  pruneBatch(id: string): { rows: number; bytes: number; durationMs: number } {
    const start = performance.now();
    const manifest = JSON.parse(this.get(id)!.manifest!) as ArchiveManifest;
    const result = this.sqlite.transaction(() => {
      const rows = this.sqlite
        .prepare(`SELECT b.rowid AS rowid, length(cast(b.content AS blob)) AS bytes
        FROM json_each(?) snapshot CROSS JOIN rome_agent_messages m CROSS JOIN rome_agent_trace_blocks b
        WHERE m.id = json_extract(snapshot.value, '$.id') AND m.trace_archive_id = ?
          AND b.message_id = m.id AND b.seq <= json_extract(snapshot.value, '$.maxSeq') AND coalesce(json_extract(b.content, '$.type'), '') NOT IN (${ARCHIVE_KEEP_BLOCK_TYPES.map(() => "?").join(",")})
        LIMIT 200`)
        .iterate(JSON.stringify(manifest.messages), id, ...ARCHIVE_KEEP_BLOCK_TYPES) as Iterable<{
        rowid: number;
        bytes: number;
      }>;
      const ids: number[] = [];
      let bytes = 0;
      for (const row of rows) {
        if (ids.length && bytes + row.bytes > 8 * 1024 * 1024) break;
        ids.push(row.rowid);
        bytes += row.bytes;
      }
      if (ids.length)
        this.sqlite
          .prepare(
            `DELETE FROM rome_agent_trace_blocks WHERE rowid IN (${ids.map(() => "?").join(",")})`,
          )
          .run(...ids);
      return { rows: ids.length, bytes };
    })();
    return { ...result, durationMs: performance.now() - start };
  }

  deletes(): string[] {
    return (
      this.sqlite.prepare("SELECT session_id FROM rome_trace_archive_deletes").all() as {
        session_id: string;
      }[]
    ).map((r) => r.session_id);
  }
  finishDelete(sessionId: string) {
    this.sqlite.transaction(() => {
      this.sqlite.prepare("DELETE FROM rome_trace_archives WHERE session_id = ?").run(sessionId);
      this.sqlite
        .prepare("DELETE FROM rome_trace_archive_deletes WHERE session_id = ?")
        .run(sessionId);
    })();
  }

  quietState(now: Date) {
    const latest = this.sqlite
      .prepare(
        `SELECT max(created_at) AS at FROM rome_agent_messages WHERE role IN (${TRACE_ACTIVITY_ROLES.map(() => "?").join(",")})`,
      )
      .get(...TRACE_ACTIVITY_ROLES) as { at: number | null };
    const due = this.sqlite
      .prepare("SELECT 1 FROM routines WHERE enabled = 1 AND next_run_at <= ? LIMIT 1")
      .get(Math.floor(now.getTime() / 1000) + 600);
    return {
      lastActivityAt: latest.at === null ? null : latest.at * 1000,
      routineDue: Boolean(due),
    };
  }
}
