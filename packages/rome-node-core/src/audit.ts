// Device audit log: a local, append-only record of every remote request this host handles.
// Design: docs/rome-node.md#device-audit-log. The log never leaves this computer.
import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync, statSync } from "node:fs";
import { dirname } from "node:path";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { ensurePrivateDirectory } from "./storage.js";

const AUDIT_SCHEMA_VERSION = 1;
/** Retention: whichever limit is reached first. */
const AUDIT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const AUDIT_MAX_BYTES = 1024 * 1024 * 1024;
/** Each stdout or stderr keeps its first 32 MiB, the most one response frame can carry. */
export const AUDIT_OUTPUT_BYTES = 32 * 1024 * 1024;
/** A pushed file at most this large is stored in full. */
export const AUDIT_PUSH_BYTES = 10 * 1024 * 1024;
const RETRY_MS = 5000;
const PRUNE_MS = 60 * 60 * 1000;

export type AuditKind = "host" | "start" | "end" | "prune";
export type AuditOutcome = "ok" | "exit_nonzero" | "error" | "interrupted";
export type ContentName = "stdin" | "stdout" | "stderr" | "file";
export type AuditUnavailableCode = "sqlite_missing" | "newer_schema" | "unreadable" | "io";
export type AuditStatus =
  | { state: "ok" }
  | { state: "unavailable"; code: AuditUnavailableCode; message: string };

/** Size and SHA-256 of a payload, and how many of its bytes are kept. */
interface ContentInfo {
  size: number;
  sha256: string;
  storedBytes: number;
}

export interface AuditEvent {
  seq: number;
  at: number;
  kind: AuditKind;
  action: string | null;
  startSeq: number | null;
  outcome: AuditOutcome | null;
  record: Record<string, unknown>;
}

/** A start record with its end, or a host or prune record. `end` is null when none was written. */
export interface AuditItem extends AuditEvent {
  end: AuditEvent | null;
}

export interface AuditQuery {
  /** Only records older than this seq, for paging back. */
  beforeSeq?: number;
  /** Only records newer than this seq, for following. */
  afterSeq?: number;
  limit?: number;
  since?: number;
  until?: number;
  action?: string;
  /** An end outcome, or `no_end` for a start without an end record. */
  outcome?: AuditOutcome | "no_end";
  /** Substring of the start or end record text, such as a request ID or a command. */
  text?: string;
  /** Only requests, without host and prune records. */
  requestsOnly?: boolean;
  /** Only requests with this result, as the device pages group them. */
  result?: AuditResult;
}

/**
 * A request's result as the device pages count it: `failed` is a non-zero exit or an error,
 * and `no_result` is an interrupted request or one without an end record.
 */
export type AuditResult = "succeeded" | "failed" | "no_result";
const RESULT_SQL = `CASE WHEN e.seq IS NULL OR e.outcome = 'interrupted' THEN 'no_result'
  WHEN e.outcome = 'ok' THEN 'succeeded' ELSE 'failed' END`;

/** Requests per result and time bucket, in the shape of the caller's `log.stats`. */
export interface AuditStats {
  since: number;
  until: number;
  bucketMs: number;
  groups: { peer: null; bucket: number; result: AuditResult; count: number }[];
}

export interface AuditSummary {
  path: string;
  status: AuditStatus;
  bytes: number;
  records: number;
  requests: number;
  oldestAt: number | null;
  newestAt: number | null;
  lastPrune: AuditEvent | null;
  retention: { maxAgeDays: number; maxBytes: number };
}

export interface AuditOpenOptions {
  path: string;
  entry: "cli" | "desktop";
  /** What a refused caller is told to do, for this entry point. */
  hint: string;
  version?: string;
  /** Reader mode for the CLI: no writes, no host record, no pruning. */
  readOnly?: boolean;
  /** Tests only. */
  now?: () => number;
  maxAgeMs?: number;
  maxBytes?: number;
}

interface Row {
  at: number;
  kind: AuditKind;
  action: string | null;
  startSeq: number | null;
  outcome: AuditOutcome | null;
  text: string;
  content: [ContentName, Buffer][];
}

const sha256 = (data: Uint8Array | string) => createHash("sha256").update(data).digest("hex");

/** Overwrites each secret occurrence with as many `*` bytes, so byte offsets stay valid. */
function maskBytes(data: Buffer, secrets: string[]): Buffer {
  for (const secret of secrets) {
    const needle = Buffer.from(secret);
    if (!needle.byteLength) continue;
    for (let at = data.indexOf(needle); at !== -1; at = data.indexOf(needle, at + needle.length))
      data.fill(0x2a, at, at + needle.byteLength);
  }
  return data;
}

function sqliteCode(error: unknown): AuditUnavailableCode {
  const code = (error as { errcode?: number } | null)?.errcode;
  // SQLITE_CORRUPT and SQLITE_NOTADB (primary codes 11 and 26).
  return code !== undefined && [11, 26].includes(code & 0xff) ? "unreadable" : "io";
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * The audit database. `open` never throws: it reports `unavailable` with a reason instead, and
 * the host then refuses every remote request except system.info. The file is never renamed,
 * deleted, or replaced by this code; the user moves a damaged file away.
 */
export class AuditStore {
  private db: DatabaseSync | null = null;
  private current: AuditStatus = { state: "ok" };
  private lastAttempt = 0;
  private opening: Promise<void> | null = null;
  private pending: Row[] = [];
  private pruneTimer: ReturnType<typeof setInterval> | undefined;
  private readonly now: () => number;

  private constructor(private readonly options: AuditOpenOptions) {
    this.now = options.now ?? Date.now;
  }

  get path(): string {
    return this.options.path;
  }

  get hint(): string {
    return this.options.hint;
  }

  static async open(options: AuditOpenOptions): Promise<AuditStore> {
    const store = new AuditStore(options);
    if (!options.readOnly) {
      try {
        await ensurePrivateDirectory(dirname(options.path));
      } catch (error) {
        store.fail("io", `The audit folder cannot be created: ${errorText(error)}`);
        store.lastAttempt = store.now();
        return store;
      }
    }
    store.tryOpen();
    if (!options.readOnly) {
      store.pruneTimer = setInterval(() => store.prune(), PRUNE_MS);
      store.pruneTimer.unref();
    }
    return store;
  }

  /** Reopens a log that was unavailable, at most once every 5 seconds. */
  async ensure(): Promise<void> {
    if (this.db || this.now() - this.lastAttempt < RETRY_MS) return;
    this.opening ??= (async () => {
      if (!this.options.readOnly)
        await ensurePrivateDirectory(dirname(this.options.path)).catch(() => {});
      this.tryOpen();
    })().finally(() => {
      this.opening = null;
    });
    await this.opening;
  }

  async status(): Promise<AuditStatus> {
    await this.ensure();
    return this.current;
  }

  /** The status without retrying, for synchronous readers. */
  get state(): AuditStatus {
    return this.current;
  }

  private fail(code: AuditUnavailableCode, message: string) {
    this.current = { state: "unavailable", code, message: `${message} (${this.options.path})` };
  }

  private tryOpen(): void {
    this.lastAttempt = this.now();
    const sqlite = process.getBuiltinModule?.("node:sqlite");
    if (!sqlite?.DatabaseSync) {
      this.fail("sqlite_missing", "This runtime has no built-in SQLite (node:sqlite).");
      return;
    }
    const { path, readOnly } = this.options;
    let db: DatabaseSync | null = null;
    try {
      if (readOnly && !existsSync(path)) {
        this.fail(
          "io",
          "There is no audit log yet. rome-node connect or the Rome app creates it when it first runs.",
        );
        return;
      }
      // SQLite gives the WAL and shared-memory files the main file's mode.
      if (!readOnly && !existsSync(path)) closeSync(openSync(path, "a", 0o600));
      db = new sqlite.DatabaseSync(path, readOnly ? { readOnly: true } : {});
      db.exec("PRAGMA busy_timeout = 5000");
      const version = Number(
        (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version,
      );
      if (version > AUDIT_SCHEMA_VERSION) {
        db.close();
        this.fail(
          "newer_schema",
          `The audit log was written by a newer version (schema ${version}). Update rome-node or the Rome app.`,
        );
        return;
      }
      if (readOnly) {
        if (version === 0) throw Object.assign(new Error("Not an audit log."), { errcode: 26 });
      } else {
        if (version === 0) db.exec("PRAGMA auto_vacuum = INCREMENTAL");
        db.exec("PRAGMA journal_mode = WAL");
        db.exec("PRAGMA synchronous = FULL");
        // A plain fsync does not reach the disk on macOS.
        if (process.platform === "darwin")
          db.exec("PRAGMA fullfsync = ON; PRAGMA checkpoint_fullfsync = ON");
        if (version === 0) {
          db.exec(`BEGIN IMMEDIATE;
CREATE TABLE events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  kind TEXT NOT NULL,
  action TEXT,
  start_seq INTEGER,
  outcome TEXT,
  record TEXT NOT NULL
) STRICT;
CREATE INDEX events_at ON events(at);
CREATE INDEX events_start ON events(start_seq);
CREATE TABLE content (
  seq INTEGER NOT NULL,
  name TEXT NOT NULL,
  data BLOB NOT NULL,
  PRIMARY KEY (seq, name)
) STRICT;
PRAGMA user_version = ${AUDIT_SCHEMA_VERSION};
COMMIT;`);
        }
        // SQLite opens a read-only file without an error, so a rolled-back write proves access.
        db.exec(`BEGIN IMMEDIATE; PRAGMA user_version = ${AUDIT_SCHEMA_VERSION}; ROLLBACK;`);
      }
      db.prepare("SELECT seq FROM events ORDER BY seq DESC LIMIT 1").get();
    } catch (error) {
      try {
        if (db?.isTransaction) db.exec("ROLLBACK");
        db?.close();
      } catch {}
      const code = sqliteCode(error);
      this.fail(
        code,
        code === "unreadable"
          ? "The audit log file is damaged or is not an audit log. Move it away to start a new log; Rome never deletes it."
          : `The audit log cannot be ${readOnly ? "read" : "written"}: ${errorText(error)}`,
      );
      return;
    }
    this.db = db;
    this.current = { state: "ok" };
    if (readOnly) return;
    this.host({
      event: "open",
      pid: process.pid,
      version: this.options.version ?? null,
      entry: this.options.entry,
      platform: process.platform,
      hostCwd: process.cwd(),
      path,
    });
    this.prune();
  }

  private row(
    kind: AuditKind,
    action: string | null,
    startSeq: number | null,
    outcome: AuditOutcome | null,
    record: Record<string, unknown>,
    content: Partial<Record<ContentName, Uint8Array>>,
    secrets: string[],
    limits: Partial<Record<ContentName, number>> = {},
  ): Row {
    const stored: [ContentName, Buffer][] = [];
    const info: Partial<Record<ContentName, ContentInfo>> = {};
    for (const [name, data] of Object.entries(content) as [ContentName, Uint8Array][]) {
      if (!data?.byteLength) continue;
      // A copy, so masking never changes the bytes a program or the caller receives.
      const full = maskBytes(Buffer.from(data), secrets);
      const kept = full.subarray(0, limits[name] ?? full.byteLength);
      info[name] = { size: full.byteLength, sha256: sha256(full), storedBytes: kept.byteLength };
      stored.push([name, kept]);
    }
    const body = Object.keys(info).length ? { ...record, content: info } : record;
    const text = secrets.reduce(
      (value, secret) => (secret ? value.replaceAll(secret, "[redacted]") : value),
      JSON.stringify(body),
    );
    return { at: this.now(), kind, action, startSeq, outcome, text, content: stored };
  }

  /** Inserts rows in one write transaction and returns their seqs. Throws on failure. */
  private write(rows: Row[], inside?: (db: DatabaseSync) => void): number[] {
    const db = this.db;
    if (!db) throw new Error("The audit log is not open.");
    const seqs: number[] = [];
    try {
      db.exec("BEGIN IMMEDIATE");
      inside?.(db);
      for (const row of rows) seqs.push(this.insert(db, row));
      db.exec("COMMIT");
    } catch (error) {
      try {
        if (db.isTransaction) db.exec("ROLLBACK");
      } catch {}
      this.fail(sqliteCode(error), `The audit log cannot be written: ${errorText(error)}`);
      throw error;
    }
    this.current = { state: "ok" };
    return seqs;
  }

  private insert(db: DatabaseSync, row: Row): number {
    // SQLite assigns the seq; AUTOINCREMENT never reuses one, even after a prune deleted every row.
    const seq = Number(
      db
        .prepare(
          "INSERT INTO events (at, kind, action, start_seq, outcome, record) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(row.at, row.kind, row.action, row.startSeq, row.outcome, row.text).lastInsertRowid,
    );
    for (const [name, data] of row.content)
      db.prepare("INSERT INTO content (seq, name, data) VALUES (?, ?, ?)").run(seq, name, data);
    return seq;
  }

  /**
   * Records a request before it runs, after any end records that could not be written yet.
   * Returns the start seq, or null when nothing could be recorded: the caller must not run it.
   */
  async start(
    action: string,
    record: Record<string, unknown>,
    content: { stdin?: Uint8Array } = {},
    secrets: string[] = [],
  ): Promise<number | null> {
    if (this.options.readOnly) return null;
    await this.ensure();
    if (!this.db) return null;
    const row = this.row("start", action, null, null, { action, ...record }, content, secrets);
    try {
      const seqs = this.write([...this.pending, row]);
      this.pending = [];
      return seqs[seqs.length - 1];
    } catch {
      return null;
    }
  }

  /** Records how a request ended. Never throws: a failed write waits for the next start. */
  end(
    startSeq: number,
    action: string,
    outcome: AuditOutcome,
    record: Record<string, unknown>,
    content: Partial<Record<Exclude<ContentName, "stdin">, Uint8Array>> = {},
    secrets: string[] = [],
  ): void {
    this.queue(
      this.row("end", action, startSeq, outcome, { startSeq, ...record }, content, secrets, {
        stdout: AUDIT_OUTPUT_BYTES,
        stderr: AUDIT_OUTPUT_BYTES,
      }),
    );
  }

  /** Host process and connection events. Never throws. */
  host(record: Record<string, unknown>, secrets: string[] = []): void {
    this.queue(this.row("host", null, null, null, { pid: process.pid, ...record }, {}, secrets));
  }

  private queue(row: Row) {
    if (this.options.readOnly) return;
    this.pending.push(row);
    if (!this.db) return;
    try {
      this.write(this.pending);
      this.pending = [];
    } catch {}
  }

  /** Applies retention in one transaction and appends a prune record when it deleted anything. */
  prune(): void {
    if (this.options.readOnly || !this.db) return;
    const maxAge = this.options.maxAgeMs ?? AUDIT_MAX_AGE_MS;
    const maxBytes = this.options.maxBytes ?? AUDIT_MAX_BYTES;
    const target = Math.floor(maxBytes * 0.9);
    let marker: Row | null = null;
    try {
      this.write([], (db) => {
        for (const row of this.pending) this.insert(db, row);
        let rowsThroughSeq: number | null = null;
        let contentThroughSeq: number | null = null;
        let reason: "age" | "size" | null = null;
        const deleteRows = (through: number) => {
          rowsThroughSeq = through;
          contentThroughSeq = Math.max(contentThroughSeq ?? 0, through);
          db.prepare("DELETE FROM content WHERE seq <= ?").run(through);
          db.prepare("DELETE FROM events WHERE seq <= ?").run(through);
        };
        const aged = db
          .prepare("SELECT max(seq) AS seq FROM events WHERE at < ?")
          .get(this.now() - maxAge) as { seq: number | null };
        if (aged.seq !== null) {
          deleteRows(Number(aged.seq));
          reason = "age";
        }
        const used = () => {
          const pages = db.prepare("PRAGMA page_count").get() as { page_count: number };
          const free = db.prepare("PRAGMA freelist_count").get() as { freelist_count: number };
          const size = db.prepare("PRAGMA page_size").get() as { page_size: number };
          return (Number(pages.page_count) - Number(free.freelist_count)) * Number(size.page_size);
        };
        let bytes = used();
        if (bytes > maxBytes) {
          // Oldest content first; the records that describe it stay.
          let freed = 0;
          let through: number | null = null;
          for (const row of db
            .prepare(
              "SELECT seq, sum(length(data)) AS bytes FROM content GROUP BY seq ORDER BY seq",
            )
            .iterate() as Iterable<{ seq: number; bytes: number }>) {
            freed += Number(row.bytes);
            through = Number(row.seq);
            if (bytes - freed < target) break;
          }
          if (through !== null) {
            db.prepare("DELETE FROM content WHERE seq <= ?").run(through);
            contentThroughSeq = Math.max(contentThroughSeq ?? 0, through);
            reason = "size";
          }
          bytes = used();
          if (bytes > maxBytes) {
            let rowsFreed = 0;
            let rowsThrough: number | null = null;
            for (const row of db
              .prepare("SELECT seq, length(record) + 200 AS bytes FROM events ORDER BY seq")
              .iterate() as Iterable<{ seq: number; bytes: number }>) {
              rowsFreed += Number(row.bytes);
              rowsThrough = Number(row.seq);
              if (bytes - rowsFreed < target) break;
            }
            if (rowsThrough !== null) {
              deleteRows(rowsThrough);
              reason = "size";
            }
          }
        }
        if (!reason) return;
        marker = this.row(
          "prune",
          null,
          null,
          null,
          { reason, rowsThroughSeq, contentThroughSeq },
          {},
          [],
        );
        this.insert(db, marker);
      });
      this.pending = [];
      if (marker) this.db.exec("PRAGMA incremental_vacuum");
    } catch {}
  }

  /** Writes a closing host record and closes the database. */
  close(): void {
    clearInterval(this.pruneTimer);
    if (!this.options.readOnly) this.host({ event: "close", pid: process.pid });
    try {
      this.db?.close();
    } catch {}
    this.db = null;
  }

  // ── Readers ──

  private reader(): DatabaseSync {
    if (!this.db)
      throw new Error(
        this.current.state === "unavailable" ? this.current.message : "The audit log is not open.",
      );
    return this.db;
  }

  private event(row: Record<string, SQLInputValue>): AuditEvent {
    return {
      seq: Number(row.seq),
      at: Number(row.at),
      kind: row.kind as AuditKind,
      action: (row.action as string | null) ?? null,
      startSeq: row.start_seq === null ? null : Number(row.start_seq),
      outcome: (row.outcome as AuditOutcome | null) ?? null,
      record: JSON.parse(String(row.record)) as Record<string, unknown>,
    };
  }

  private withEnd(db: DatabaseSync, event: AuditEvent): AuditItem {
    if (event.kind !== "start") return { ...event, end: null };
    const end = db
      .prepare("SELECT * FROM events WHERE kind = 'end' AND start_seq = ? ORDER BY seq LIMIT 1")
      .get(event.seq) as Record<string, SQLInputValue> | undefined;
    return { ...event, end: end ? this.event(end) : null };
  }

  /** Requests and host and prune records, newest first. End records come with their start. */
  list(query: AuditQuery = {}): AuditItem[] {
    const db = this.reader();
    const where = ["s.kind != 'end'"];
    const params: SQLInputValue[] = [];
    const add = (clause: string, ...values: SQLInputValue[]) => {
      where.push(clause);
      params.push(...values);
    };
    if (query.beforeSeq !== undefined) add("s.seq < ?", query.beforeSeq);
    if (query.afterSeq !== undefined) add("s.seq > ?", query.afterSeq);
    if (query.since !== undefined) add("s.at >= ?", query.since);
    if (query.until !== undefined) add("s.at <= ?", query.until);
    if (query.action !== undefined) add("s.kind = 'start' AND s.action = ?", query.action);
    if (query.outcome === "no_end") add("s.kind = 'start' AND e.seq IS NULL");
    else if (query.outcome !== undefined) add("e.outcome = ?", query.outcome);
    if (query.text)
      add("(instr(s.record, ?) > 0 OR instr(e.record, ?) > 0)", query.text, query.text);
    if (query.requestsOnly || query.result) add("s.kind = 'start'");
    if (query.result) add(`${RESULT_SQL} = ?`, query.result);
    const rows = db
      .prepare(
        `SELECT s.*, e.seq AS e_seq, e.at AS e_at, e.kind AS e_kind, e.action AS e_action,
                e.start_seq AS e_start_seq, e.outcome AS e_outcome, e.record AS e_record
         FROM events s LEFT JOIN events e ON e.kind = 'end' AND e.start_seq = s.seq
         WHERE ${where.join(" AND ")} ORDER BY s.seq DESC LIMIT ?`,
      )
      .all(...params, query.limit ?? 200) as Record<string, SQLInputValue>[];
    return rows.map((row) => ({
      ...this.event(row),
      end:
        row.e_seq === null
          ? null
          : this.event({
              seq: row.e_seq,
              at: row.e_at,
              kind: row.e_kind,
              action: row.e_action,
              start_seq: row.e_start_seq,
              outcome: row.e_outcome,
              record: row.e_record,
            }),
    }));
  }

  /** Requests per result over the whole log. */
  resultCounts(): Record<AuditResult | "all", number> {
    const counts = { all: 0, succeeded: 0, failed: 0, no_result: 0 };
    const rows = this.reader()
      .prepare(
        `SELECT ${RESULT_SQL} AS result, count(*) AS n FROM events s
         LEFT JOIN events e ON e.kind = 'end' AND e.start_seq = s.seq
         WHERE s.kind = 'start' GROUP BY result`,
      )
      .all() as { result: AuditResult; n: number }[];
    for (const row of rows) {
      counts[row.result] += Number(row.n);
      counts.all += Number(row.n);
    }
    return counts;
  }

  /** Requests started in `[since, until)`, counted per result and `bucketMs` bucket. */
  stats(since: number, until: number, bucketMs: number): AuditStats {
    const groups = this.reader()
      .prepare(
        `SELECT CAST((s.at - ?) / ? AS INTEGER) AS bucket, ${RESULT_SQL} AS result, count(*) AS n FROM events s
         LEFT JOIN events e ON e.kind = 'end' AND e.start_seq = s.seq
         WHERE s.kind = 'start' AND s.at >= ? AND s.at < ? GROUP BY bucket, result`,
      )
      .all(since, bucketMs, since, until) as { bucket: number; result: AuditResult; n: number }[];
    return {
      since,
      until,
      bucketMs,
      groups: groups.map((row) => ({
        peer: null,
        bucket: Math.floor(Number(row.bucket)),
        result: row.result,
        count: Number(row.n),
      })),
    };
  }

  /** One record. An end seq returns its start with the end. */
  get(seq: number): AuditItem | null {
    const db = this.reader();
    const row = db.prepare("SELECT * FROM events WHERE seq = ?").get(seq) as
      | Record<string, SQLInputValue>
      | undefined;
    if (!row) return null;
    const event = this.event(row);
    if (event.kind === "end" && event.startSeq !== null) {
      const start = db.prepare("SELECT * FROM events WHERE seq = ?").get(event.startSeq) as
        | Record<string, SQLInputValue>
        | undefined;
      if (start) return { ...this.event(start), end: event };
    }
    return this.withEnd(db, event);
  }

  /** Stored bytes of one payload, or null when there are none (never stored, or pruned). */
  content(seq: number, name: ContentName): Buffer | null {
    const row = this.reader()
      .prepare("SELECT data FROM content WHERE seq = ? AND name = ?")
      .get(seq, name) as { data: Uint8Array } | undefined;
    return row ? Buffer.from(row.data) : null;
  }

  summary(): AuditSummary {
    const retention = {
      maxAgeDays: (this.options.maxAgeMs ?? AUDIT_MAX_AGE_MS) / 86_400_000,
      maxBytes: this.options.maxBytes ?? AUDIT_MAX_BYTES,
    };
    let bytes = 0;
    for (const suffix of ["", "-wal"]) {
      try {
        bytes += statSync(this.options.path + suffix).size;
      } catch {}
    }
    const base = { path: this.options.path, status: this.current, bytes, retention };
    if (!this.db)
      return { ...base, records: 0, requests: 0, oldestAt: null, newestAt: null, lastPrune: null };
    const db = this.db;
    const counts = db
      .prepare(
        "SELECT count(*) AS records, sum(kind = 'start') AS requests, min(at) AS oldest, max(at) AS newest FROM events",
      )
      .get() as Record<string, number | null>;
    const prune = db
      .prepare("SELECT * FROM events WHERE kind = 'prune' ORDER BY seq DESC LIMIT 1")
      .get() as Record<string, SQLInputValue> | undefined;
    return {
      ...base,
      records: Number(counts.records ?? 0),
      requests: Number(counts.requests ?? 0),
      oldestAt: counts.oldest === null ? null : Number(counts.oldest),
      newestAt: counts.newest === null ? null : Number(counts.newest),
      lastPrune: prune ? this.event(prune) : null,
    };
  }
}
