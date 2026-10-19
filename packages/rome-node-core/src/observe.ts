// The daemon's observation log, `<configDir>/observe.db`. The daemon is its only writer. Every
// method swallows storage failures, because observation must never block or fail an action.
import { closeSync, existsSync, openSync, readdirSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";
import {
  ACTION_RESULTS,
  OUTCOMES,
  type ActionRow,
  type LogQuery,
  type LogResult,
  type LogStats,
  type LogStatsQuery,
  type Outcome,
} from "./observe-protocol.js";

const SCHEMA_VERSION = 1;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Query results and events carry at most this many characters of text per action. */
export const MAX_ROW_CHARS = 16 * 1024;
const MAX_RESULT_BYTES = 768 * 1024;
const MAX_LIMIT = 500;
const MAX_BUCKETS = 1000;

/** The `ActionResult` of the row aliased `a`. Matches the definition in observe-protocol.ts. */
const RESULT_SQL = `CASE
  WHEN a.ended_at IS NULL THEN 'running'
  WHEN a.outcome = 'ok' AND coalesce(a.exit_code, 0) = 0 AND a.signal IS NULL THEN 'succeeded'
  WHEN a.outcome IN ('ok', 'error') THEN 'failed'
  ELSE 'no_result' END`;

export interface ObserveStoreOptions {
  path: string;
  /** Each occurrence is stored as the same number of `*`. */
  secrets?: string[];
  retentionMs?: number;
  maxBytes?: number;
  now?: () => number;
}

/** The start of an action. Text fields are stored in full, after masking. */
export interface ActionStart {
  direction: "in" | "out";
  peer: string | null;
  action: string;
  mode: ActionRow["mode"];
  command?: string | null;
  args?: string[] | string | null;
  cwd?: string | null;
  stdinBytes?: number;
  transfer?: { direction: "push" | "pull"; localPath: string; remotePath: string } | null;
}

export interface ActionEnd {
  outcome: Exclude<Outcome, "interrupted">;
  errorCode?: string | null;
  exitCode?: number | null;
  signal?: string | null;
  stdoutBytes?: number;
  stderrBytes?: number;
  transferBytes?: number | null;
  sha256?: string | null;
}

export class QueryError extends Error {}

/** The file is not a sound SQLite database. */
class CorruptDatabaseError extends Error {}
/** The file is sound but was written by a daemon with another schema version. */
class SchemaVersionError extends Error {}

function isCorruption(error: unknown): boolean {
  if (error instanceof CorruptDatabaseError) return true;
  const code = (error as { errcode?: unknown } | null)?.errcode;
  // SQLITE_CORRUPT and SQLITE_NOTADB, including their extended codes.
  return typeof code === "number" && ((code & 0xff) === 11 || (code & 0xff) === 26);
}

const SCHEMA = `
CREATE TABLE actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  direction TEXT NOT NULL,
  peer TEXT,
  action TEXT NOT NULL,
  mode TEXT NOT NULL,
  command TEXT,
  args TEXT,
  cwd TEXT,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  outcome TEXT,
  error_code TEXT,
  exit_code INTEGER,
  signal TEXT,
  stdin_bytes INTEGER NOT NULL DEFAULT 0,
  stdout_bytes INTEGER NOT NULL DEFAULT 0,
  stderr_bytes INTEGER NOT NULL DEFAULT 0,
  transfer_direction TEXT,
  local_path TEXT,
  remote_path TEXT,
  transfer_bytes INTEGER,
  sha256 TEXT
);
CREATE INDEX actions_started_at ON actions(started_at);
CREATE INDEX actions_direction ON actions(direction, id);
CREATE INDEX actions_peer ON actions(peer, id);
CREATE INDEX actions_outcome ON actions(outcome, id);
CREATE INDEX actions_open ON actions(id) WHERE ended_at IS NULL;
CREATE VIRTUAL TABLE actions_fts USING fts5(
  command, args, cwd, content='actions', content_rowid='id', tokenize='trigram'
);
CREATE TRIGGER actions_fts_insert AFTER INSERT ON actions BEGIN
  INSERT INTO actions_fts(rowid, command, args, cwd)
  VALUES (new.id, coalesce(new.command, ''), coalesce(new.args, ''), coalesce(new.cwd, ''));
END;
CREATE TRIGGER actions_fts_delete AFTER DELETE ON actions BEGIN
  INSERT INTO actions_fts(actions_fts, rowid, command, args, cwd)
  VALUES ('delete', old.id, coalesce(old.command, ''), coalesce(old.args, ''), coalesce(old.cwd, ''));
END;
`;

type Row = Record<string, SQLInputValue>;

interface Budget {
  remaining: number;
  truncated: boolean;
}

/** Spends `value.length` of the row's character budget and cuts the value when the budget ends. */
function cut(value: string | null, budget: Budget): string | null {
  if (value === null) return value;
  if (value.length <= budget.remaining) {
    budget.remaining -= value.length;
    return value;
  }
  budget.truncated = true;
  const kept = value.slice(0, budget.remaining);
  budget.remaining = 0;
  return kept;
}

function toActionRow(row: Row): ActionRow {
  const state: Budget = { remaining: MAX_ROW_CHARS, truncated: false };
  // The command and cwd identify the action, so they spend the budget before the arguments.
  const command = cut(row.command as string | null, state);
  const cwd = cut(row.cwd as string | null, state);
  let args: ActionRow["args"] = null;
  if (typeof row.args === "string") {
    let parsed: unknown;
    try {
      parsed = row.command === null ? undefined : JSON.parse(row.args);
    } catch {}
    if (Array.isArray(parsed)) {
      args = [];
      for (const arg of parsed) {
        if (!state.remaining) {
          state.truncated = true;
          break;
        }
        args.push(cut(String(arg), state) ?? "");
      }
    } else args = cut(row.args, state);
  }
  const value: ActionRow = {
    id: Number(row.id),
    direction: row.direction as ActionRow["direction"],
    peer: row.peer as string | null,
    action: row.action as string,
    mode: row.mode as ActionRow["mode"],
    command,
    args,
    cwd,
    startedAt: Number(row.started_at),
    endedAt: row.ended_at === null ? null : Number(row.ended_at),
    outcome: row.outcome as Outcome | null,
    errorCode: row.error_code as string | null,
    exitCode: row.exit_code === null ? null : Number(row.exit_code),
    signal: row.signal as string | null,
    stdinBytes: Number(row.stdin_bytes),
    stdoutBytes: Number(row.stdout_bytes),
    stderrBytes: Number(row.stderr_bytes),
    transfer:
      row.transfer_direction === null
        ? null
        : {
            direction: row.transfer_direction as "push" | "pull",
            localPath: cut(row.local_path as string, state) ?? "",
            remotePath: cut(row.remote_path as string, state) ?? "",
            bytes: row.transfer_bytes === null ? null : Number(row.transfer_bytes),
            sha256: row.sha256 as string | null,
          },
  };
  if (state.truncated) value.truncated = true;
  return value;
}

const optionalId = (value: unknown, name: string): number | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new QueryError(`${name} must be a non-negative integer.`);
  return value;
};

/** Adds the filters `log.query` and `log.stats` share to `where` and `params`. */
function commonFilters(
  query: { direction?: unknown; peer?: unknown; since?: unknown; until?: unknown },
  where: string[],
  params: SQLInputValue[],
) {
  if (query.direction !== undefined) {
    if (query.direction !== "in" && query.direction !== "out")
      throw new QueryError("direction must be in or out.");
    where.push("a.direction = ?");
    params.push(query.direction);
  }
  if (query.peer !== undefined) {
    if (typeof query.peer !== "string") throw new QueryError("peer must be a string.");
    where.push("a.peer = ?");
    params.push(query.peer);
  }
  const since = optionalId(query.since, "since");
  const until = optionalId(query.until, "until");
  if (since !== undefined) where.push("a.started_at >= ?"), params.push(since);
  if (until !== undefined) where.push("a.started_at < ?"), params.push(until);
}

export class ObserveStore {
  private db?: DatabaseSync;
  private statements = new Map<string, StatementSync>();
  private readonly secrets: string[];
  private readonly retentionMs: number;
  private readonly maxBytes: number;
  private readonly now: () => number;

  constructor(private readonly options: ObserveStoreOptions) {
    this.secrets = (options.secrets ?? []).filter(Boolean);
    this.retentionMs = options.retentionMs ?? 30 * DAY_MS;
    this.maxBytes = options.maxBytes ?? 64 * 1024 * 1024;
    this.now = options.now ?? Date.now;
  }

  /**
   * Opens or creates the database and marks actions a previous start left open as interrupted.
   * Never throws. When the file cannot be used, the store stays closed and records nothing.
   */
  open(): void {
    this.db = this.attach();
    if (!this.db) return;
    this.guard(() => {
      this.run(
        "UPDATE actions SET ended_at = ?, outcome = 'interrupted' WHERE ended_at IS NULL",
        this.now(),
      );
    });
    this.prune();
  }

  /**
   * Connects, replacing a corrupt file or one from another schema version. Any other failure,
   * such as a lock, a permission error, or a full disk, leaves the file as it is and returns
   * undefined, so a sound log is never thrown away for a passing condition.
   */
  private attach(): DatabaseSync | undefined {
    try {
      return this.connect();
    } catch (error) {
      if (error instanceof SchemaVersionError) {
        if (!this.discard(false)) return undefined;
      } else if (isCorruption(error)) {
        if (!this.discard(true)) return undefined;
      } else return undefined;
    }
    try {
      return this.connect();
    } catch {
      return undefined;
    }
  }

  private connect(): DatabaseSync {
    const { path } = this.options;
    // SQLite gives the WAL and shared-memory files the main file's mode, so creating the main
    // file first with 0600 keeps all three private.
    if (!existsSync(path)) closeSync(openSync(path, "a", 0o600));
    const db = new DatabaseSync(path);
    try {
      db.exec("PRAGMA busy_timeout = 1000");
      const check = db.prepare("PRAGMA quick_check").get();
      if (check?.quick_check !== "ok") throw new CorruptDatabaseError();
      const version = Number(db.prepare("PRAGMA user_version").get()?.user_version ?? 0);
      if (version === 0) {
        // auto_vacuum only takes effect before the first table exists.
        db.exec("PRAGMA auto_vacuum = INCREMENTAL");
        db.exec("PRAGMA journal_mode = WAL");
        db.exec(`BEGIN; ${SCHEMA} PRAGMA user_version = ${SCHEMA_VERSION}; COMMIT;`);
      } else if (version !== SCHEMA_VERSION) {
        throw new SchemaVersionError();
      } else db.exec("PRAGMA journal_mode = WAL");
      db.exec("PRAGMA synchronous = NORMAL");
      return db;
    } catch (error) {
      db.close();
      throw error;
    }
  }

  /**
   * Closes the store and removes the database with its WAL and shared-memory files. With
   * `keepCopy`, the file moves to `observe.db.corrupt-<ms>` and older copies are deleted, so at
   * most one copy exists. Returns false and leaves logging off when any step fails, because a
   * fresh file next to a stale WAL would replay the old frames into it.
   */
  private discard(keepCopy: boolean): boolean {
    const { path } = this.options;
    this.statements.clear();
    try {
      this.db?.close();
    } catch {}
    this.db = undefined;
    try {
      if (keepCopy) {
        const prefix = `${basename(path)}.corrupt-`;
        for (const name of readdirSync(dirname(path)))
          if (name.startsWith(prefix)) rmSync(join(dirname(path), name), { force: true });
        if (existsSync(path)) renameSync(path, `${path}.corrupt-${this.now()}`);
      } else rmSync(path, { force: true });
      for (const suffix of ["-wal", "-shm"]) rmSync(`${path}${suffix}`, { force: true });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Runs `work` and turns any storage failure into `fallback`. Never throws. Corruption sets the
   * file aside and starts a new one.
   */
  private guard<T>(work: () => T, fallback?: T): T | undefined {
    if (!this.db) return fallback;
    try {
      return work();
    } catch (error) {
      if (isCorruption(error)) this.db = this.discard(true) ? this.attach() : undefined;
      return fallback;
    }
  }

  private statement(sql: string): StatementSync {
    let statement = this.statements.get(sql);
    if (!statement) {
      statement = this.db!.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }

  private run(sql: string, ...params: SQLInputValue[]) {
    return this.statement(sql).run(...params);
  }

  private all(sql: string, ...params: SQLInputValue[]): Row[] {
    return this.statement(sql).all(...params) as Row[];
  }

  private mask(value: string): string;
  private mask(value: string | null | undefined): string | null;
  private mask(value: string | null | undefined): string | null {
    if (value === null || value === undefined) return null;
    let masked = value;
    for (const secret of this.secrets)
      masked = masked.split(secret).join("*".repeat(secret.length));
    return masked;
  }

  /** Returns the stored row, or null when storage is unavailable. */
  startAction(start: ActionStart): ActionRow | null {
    return (
      this.guard(() => {
        const args =
          start.args === undefined || start.args === null
            ? null
            : typeof start.args === "string"
              ? this.mask(start.args)
              : JSON.stringify(start.args.map((arg) => this.mask(arg)));
        const result = this.run(
          `INSERT INTO actions (direction, peer, action, mode, command, args, cwd, started_at,
             stdin_bytes, transfer_direction, local_path, remote_path)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          start.direction,
          this.mask(start.peer),
          start.action,
          start.mode,
          this.mask(start.command),
          args,
          this.mask(start.cwd),
          this.now(),
          start.stdinBytes ?? 0,
          start.transfer?.direction ?? null,
          this.mask(start.transfer?.localPath),
          this.mask(start.transfer?.remotePath),
        );
        return this.action(Number(result.lastInsertRowid));
      }, null) ?? null
    );
  }

  endAction(id: number, end: ActionEnd): ActionRow | null {
    return (
      this.guard(() => {
        this.run(
          `UPDATE actions SET ended_at = ?, outcome = ?, error_code = ?, exit_code = ?, signal = ?,
             stdout_bytes = ?, stderr_bytes = ?, transfer_bytes = ?, sha256 = ?
           WHERE id = ? AND ended_at IS NULL`,
          this.now(),
          end.outcome,
          end.errorCode ?? null,
          end.exitCode ?? null,
          end.signal ?? null,
          end.stdoutBytes ?? 0,
          end.stderrBytes ?? 0,
          end.transferBytes ?? null,
          end.sha256 ?? null,
          id,
        );
        return this.action(id);
      }, null) ?? null
    );
  }

  private action(id: number): ActionRow | null {
    const row = this.all("SELECT * FROM actions WHERE id = ?", id)[0];
    return row ? toActionRow(row) : null;
  }

  /** Actions without an end, oldest first. */
  running(): ActionRow[] {
    return (
      this.guard(
        () =>
          this.all(
            "SELECT * FROM actions WHERE ended_at IS NULL ORDER BY id LIMIT ?",
            MAX_LIMIT,
          ).map(toActionRow),
        [],
      ) ?? []
    );
  }

  /** Throws QueryError for an invalid query. Storage failures return an empty result. */
  query(query: LogQuery): LogResult<ActionRow> {
    if (query.kind !== "actions") throw new QueryError("Unknown query kind.");
    return this.queryActions(query);
  }

  private limit(value: unknown, fallback: number): number {
    if (value === undefined) return fallback;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1)
      throw new QueryError("limit must be a positive integer.");
    return Math.min(value, MAX_LIMIT);
  }

  private queryActions(query: Extract<LogQuery, { kind: "actions" }>): LogResult<ActionRow> {
    const where: string[] = [];
    const params: SQLInputValue[] = [];
    const before = optionalId(query.before, "before");
    const limit = this.limit(query.limit, 100);
    if (before !== undefined) where.push("a.id < ?"), params.push(before);
    commonFilters(query, where, params);
    if (query.outcome !== undefined) {
      if (
        !Array.isArray(query.outcome) ||
        !query.outcome.length ||
        !query.outcome.every((outcome) => OUTCOMES.includes(outcome))
      )
        throw new QueryError("outcome must list known outcomes.");
      where.push(`a.outcome IN (${query.outcome.map(() => "?").join(", ")})`);
      params.push(...query.outcome);
    }
    if (query.result !== undefined) {
      if (
        !Array.isArray(query.result) ||
        !query.result.length ||
        !query.result.every((result) => ACTION_RESULTS.includes(result))
      )
        throw new QueryError("result must list known results.");
      where.push(`${RESULT_SQL} IN (${query.result.map(() => "?").join(", ")})`);
      params.push(...query.result);
    }
    let join = "";
    if (query.text !== undefined) {
      if (typeof query.text !== "string" || [...query.text].length < 3)
        throw new QueryError("text must have at least three characters.");
      join = "JOIN actions_fts ON actions_fts.rowid = a.id";
      where.push("actions_fts MATCH ?");
      // A quoted phrase makes every character literal, so user text cannot inject FTS syntax.
      params.push(`"${query.text.replaceAll('"', '""')}"`);
    }
    const sql = `SELECT a.* FROM actions a ${join} ${
      where.length ? `WHERE ${where.join(" AND ")}` : ""
    } ORDER BY a.id DESC LIMIT ?`;
    return (
      this.guard(
        () => {
          const raw = this.all(sql, ...params, limit + 1);
          const rows: ActionRow[] = [];
          let bytes = 0;
          let hasMore = raw.length > limit;
          for (const item of raw.slice(0, limit)) {
            const row = toActionRow(item);
            bytes += Buffer.byteLength(JSON.stringify(row));
            if (rows.length && bytes > MAX_RESULT_BYTES) {
              hasMore = true;
              break;
            }
            rows.push(row);
          }
          return { rows, hasMore };
        },
        { rows: [], hasMore: false },
      ) ?? { rows: [], hasMore: false }
    );
  }

  /** Throws QueryError for an invalid query. Storage failures return no groups. */
  stats(query: LogStatsQuery): LogStats {
    const since = optionalId(query.since, "since");
    if (since === undefined) throw new QueryError("since is required.");
    const until = optionalId(query.until, "until") ?? this.now();
    const bucketMs = query.bucketMs;
    if (typeof bucketMs !== "number" || !Number.isSafeInteger(bucketMs) || bucketMs < 1000)
      throw new QueryError("bucketMs must be an integer of at least 1000.");
    if (until <= since || Math.ceil((until - since) / bucketMs) > MAX_BUCKETS)
      throw new QueryError(`The range must hold between 1 and ${MAX_BUCKETS} buckets.`);
    const where: string[] = [];
    const params: SQLInputValue[] = [];
    commonFilters({ ...query, since, until }, where, params);
    // node:sqlite binds a JS number as REAL, so the division needs the cast to land on an index.
    const sql = `SELECT a.peer AS peer, CAST((a.started_at - ?) / ? AS INTEGER) AS bucket,
        ${RESULT_SQL} AS result, count(*) AS count
      FROM actions a WHERE ${where.join(" AND ")}
      GROUP BY peer, bucket, result ORDER BY bucket`;
    const groups =
      this.guard(
        () =>
          this.all(sql, since, bucketMs, ...params).map((row) => ({
            peer: row.peer as string | null,
            bucket: Number(row.bucket),
            result: row.result as LogStats["groups"][number]["result"],
            count: Number(row.count),
          })),
        [],
      ) ?? [];
    return { since, until, bucketMs, groups };
  }

  /**
   * Deletes actions past retention, then the oldest actions until the file fits its budget.
   * Cost: the budget pass rewrites the whole search index, synchronously on the daemon's event
   * loop, so it runs only when the file is over budget. Retention deletes leave their index
   * tombstones to FTS5's incremental automerge.
   */
  prune(): void {
    this.guard(() => {
      const cutoff = this.now() - this.retentionMs;
      let deleted = Number(
        this.run("DELETE FROM actions WHERE started_at < ? AND ended_at IS NOT NULL", cutoff)
          .changes,
      );
      if (this.usedBytes() > this.maxBytes) {
        this.compact();
        for (let round = 0; round < 64 && this.usedBytes() > this.maxBytes; round++) {
          // Each round drops the oldest tenth, so a large overrun converges quickly without one
          // huge delete holding the write lock.
          const count = Number(this.all("SELECT count(*) AS n FROM actions")[0]?.n ?? 0);
          if (!count) break;
          deleted += Number(
            this.run(
              `DELETE FROM actions WHERE id IN (SELECT id FROM actions WHERE ended_at IS NOT NULL
                 ORDER BY id LIMIT ?)`,
              Math.max(1, Math.ceil(count / 10)),
            ).changes,
          );
          this.compact();
        }
      }
      if (!deleted) return;
      this.db!.exec("PRAGMA incremental_vacuum");
      this.db!.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    });
  }

  /** Merges the search index so its deleted rows release their pages, then frees those pages. */
  private compact() {
    this.db!.exec("INSERT INTO actions_fts(actions_fts) VALUES ('optimize')");
    this.db!.exec("PRAGMA incremental_vacuum");
  }

  private usedBytes(): number {
    const pages = Number(this.all("PRAGMA page_count")[0]?.page_count ?? 0);
    const free = Number(this.all("PRAGMA freelist_count")[0]?.freelist_count ?? 0);
    const size = Number(this.all("PRAGMA page_size")[0]?.page_size ?? 4096);
    return (pages - free) * size;
  }

  close(): void {
    this.statements.clear();
    try {
      this.db?.close();
    } catch {}
    this.db = undefined;
  }
}
