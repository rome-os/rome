// The daemon's observation log, `<configDir>/observe.db`. The daemon is its only writer. Every
// method swallows storage failures, because observation must never block or fail an action.
import { closeSync, existsSync, openSync, renameSync, rmSync } from "node:fs";
import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";
import {
  OUTCOMES,
  type ActionRow,
  type ActionSummary,
  type LifecycleRow,
  type LogQuery,
  type LogResult,
  type Outcome,
} from "./observe-protocol.js";

const SCHEMA_VERSION = 1;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Query results and events carry at most this many characters of text per action. */
export const MAX_ROW_CHARS = 16 * 1024;
const MAX_RESULT_BYTES = 768 * 1024;
const MAX_LIMIT = 500;

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

const SCHEMA = `
CREATE TABLE boots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at INTEGER NOT NULL,
  version TEXT NOT NULL,
  platform TEXT NOT NULL,
  arch TEXT NOT NULL,
  pid INTEGER NOT NULL
);
CREATE INDEX boots_started_at ON boots(started_at);
CREATE TABLE lifecycle (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  role TEXT NOT NULL,
  event TEXT NOT NULL,
  detail TEXT NOT NULL
);
CREATE INDEX lifecycle_at ON lifecycle(at);
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

const optionalTime = (value: unknown, name: string): number | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new QueryError(`${name} must be a non-negative integer.`);
  return value;
};

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

  /** Opens or creates the database and marks actions a previous start left open as interrupted. */
  open(): void {
    try {
      this.db = this.connect();
    } catch {
      // A database that cannot be opened or checked is set aside, never repaired in place.
      this.quarantine();
      try {
        this.db = this.connect();
      } catch {
        this.db = undefined;
        return;
      }
    }
    this.guard(() => {
      this.run(
        "UPDATE actions SET ended_at = ?, outcome = 'interrupted' WHERE ended_at IS NULL",
        this.now(),
      );
    });
    this.prune();
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
      if (check?.quick_check !== "ok") throw new Error("observe.db failed its integrity check");
      const version = Number(db.prepare("PRAGMA user_version").get()?.user_version ?? 0);
      if (version === 0) {
        // auto_vacuum only takes effect before the first table exists.
        db.exec("PRAGMA auto_vacuum = INCREMENTAL");
        db.exec("PRAGMA journal_mode = WAL");
        db.exec(`BEGIN; ${SCHEMA} PRAGMA user_version = ${SCHEMA_VERSION}; COMMIT;`);
      } else if (version !== SCHEMA_VERSION) {
        throw new Error("observe.db has an unknown schema version");
      } else db.exec("PRAGMA journal_mode = WAL");
      db.exec("PRAGMA synchronous = NORMAL");
      return db;
    } catch (error) {
      db.close();
      throw error;
    }
  }

  private quarantine() {
    const { path } = this.options;
    this.statements.clear();
    try {
      this.db?.close();
    } catch {}
    this.db = undefined;
    try {
      if (existsSync(path)) renameSync(path, `${path}.corrupt-${this.now()}`);
    } catch {}
    for (const suffix of ["-wal", "-shm"]) rmSync(`${path}${suffix}`, { force: true });
  }

  /** Runs `work` and turns any storage failure into `fallback`. Corruption starts a new file. */
  private guard<T>(work: () => T, fallback?: T): T | undefined {
    if (!this.db) return fallback;
    try {
      return work();
    } catch (error) {
      const code = (error as { errcode?: number }).errcode;
      // SQLITE_CORRUPT and SQLITE_NOTADB, including their extended codes.
      if (code !== undefined && ((code & 0xff) === 11 || (code & 0xff) === 26)) {
        this.quarantine();
        try {
          this.db = this.connect();
        } catch {
          this.db = undefined;
        }
      }
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

  recordBoot(boot: { version: string; platform: string; arch: string; pid: number }) {
    this.guard(() => {
      const at = this.now();
      this.run(
        "INSERT INTO boots (started_at, version, platform, arch, pid) VALUES (?, ?, ?, ?, ?)",
        at,
        boot.version,
        boot.platform,
        boot.arch,
        boot.pid,
      );
      this.recordLifecycle("daemon", "start", boot.version, at);
    });
  }

  recordLifecycle(
    role: LifecycleRow["role"],
    event: LifecycleRow["event"],
    detail: string,
    at = this.now(),
  ) {
    this.guard(() =>
      this.run(
        "INSERT INTO lifecycle (at, role, event, detail) VALUES (?, ?, ?, ?)",
        at,
        role,
        event,
        detail,
      ),
    );
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
  query(query: LogQuery): LogResult<ActionRow | LifecycleRow> | ActionSummary {
    switch (query.kind) {
      case "actions":
        return this.queryActions(query);
      case "lifecycle":
        return this.queryLifecycle(query);
      case "summary":
        return this.summary(query);
      default:
        throw new QueryError("Unknown query kind.");
    }
  }

  private oldest(table: "actions" | "lifecycle"): number | null {
    const column = table === "actions" ? "started_at" : "at";
    const value = this.all(`SELECT min(${column}) AS oldest FROM ${table}`)[0]?.oldest;
    return value === null || value === undefined ? null : Number(value);
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
    const from = optionalTime(query.from, "from");
    const to = optionalTime(query.to, "to");
    const after = optionalTime(query.after, "after");
    const before = optionalTime(query.before, "before");
    const minDuration = optionalTime(query.minDurationMs, "minDurationMs");
    const limit = this.limit(query.limit, 100);
    if (from !== undefined) where.push("a.started_at >= ?"), params.push(from);
    if (to !== undefined) where.push("a.started_at < ?"), params.push(to);
    if (after !== undefined) where.push("a.id > ?"), params.push(after);
    if (before !== undefined) where.push("a.id < ?"), params.push(before);
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
    if (minDuration !== undefined) {
      where.push("a.ended_at IS NOT NULL AND a.ended_at - a.started_at >= ?");
      params.push(minDuration);
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
    const order = after !== undefined ? "ASC" : "DESC";
    const sql = `SELECT a.* FROM actions a ${join} ${
      where.length ? `WHERE ${where.join(" AND ")}` : ""
    } ORDER BY a.id ${order} LIMIT ?`;
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
          return { rows, hasMore, oldest: this.oldest("actions") };
        },
        { rows: [], hasMore: false, oldest: null },
      ) ?? { rows: [], hasMore: false, oldest: null }
    );
  }

  private queryLifecycle(query: Extract<LogQuery, { kind: "lifecycle" }>): LogResult<LifecycleRow> {
    const from = optionalTime(query.from, "from") ?? 0;
    const to = optionalTime(query.to, "to") ?? Number.MAX_SAFE_INTEGER;
    const limit = this.limit(query.limit, 100);
    const empty: LogResult<LifecycleRow> = { rows: [], hasMore: false, oldest: null };
    return (
      this.guard((): LogResult<LifecycleRow> => {
        const raw = this.all(
          "SELECT * FROM lifecycle WHERE at >= ? AND at < ? ORDER BY id DESC LIMIT ?",
          from,
          to,
          limit + 1,
        );
        return {
          rows: raw.slice(0, limit).map(
            (row): LifecycleRow => ({
              id: Number(row.id),
              at: Number(row.at),
              role: row.role as LifecycleRow["role"],
              event: row.event as LifecycleRow["event"],
              detail: String(row.detail),
            }),
          ),
          hasMore: raw.length > limit,
          oldest: this.oldest("lifecycle"),
        };
      }, empty) ?? empty
    );
  }

  private summary(query: Extract<LogQuery, { kind: "summary" }>): ActionSummary {
    const from = optionalTime(query.from, "from");
    const to = optionalTime(query.to, "to");
    if (from === undefined || to === undefined || to <= from)
      throw new QueryError("summary requires from < to.");
    const empty: ActionSummary = { total: 0, running: 0, byOutcome: {}, byDirection: {} };
    return (
      this.guard(() => {
        const summary: ActionSummary = { total: 0, running: 0, byOutcome: {}, byDirection: {} };
        for (const row of this.all(
          `SELECT direction, outcome, count(*) AS n FROM actions
           WHERE started_at >= ? AND started_at < ? GROUP BY direction, outcome`,
          from,
          to,
        )) {
          const count = Number(row.n);
          const direction = row.direction as "in" | "out";
          summary.total += count;
          summary.byDirection[direction] = (summary.byDirection[direction] ?? 0) + count;
          if (row.outcome === null) summary.running += count;
          else {
            const outcome = row.outcome as Outcome;
            summary.byOutcome[outcome] = (summary.byOutcome[outcome] ?? 0) + count;
          }
        }
        return summary;
      }, empty) ?? empty
    );
  }

  /** Deletes entries past retention, then the oldest entries until the file fits its budget. */
  prune(): void {
    this.guard(() => {
      const cutoff = this.now() - this.retentionMs;
      this.run("DELETE FROM actions WHERE started_at < ? AND ended_at IS NOT NULL", cutoff);
      this.run("DELETE FROM lifecycle WHERE at < ?", cutoff);
      this.run("DELETE FROM boots WHERE started_at < ?", cutoff);
      for (let round = 0; round < 64 && this.usedBytes() > this.maxBytes; round++) {
        // Each round drops the oldest tenth of each table, so a large overrun converges quickly
        // without one huge delete holding the write lock.
        for (const [table, key] of [
          ["actions", "id"],
          ["lifecycle", "id"],
        ] as const) {
          const count = Number(this.all(`SELECT count(*) AS n FROM ${table}`)[0]?.n ?? 0);
          if (!count) continue;
          const take = Math.max(1, Math.ceil(count / 10));
          this.run(
            `DELETE FROM ${table} WHERE ${key} IN (SELECT ${key} FROM ${table} ${
              table === "actions" ? "WHERE ended_at IS NOT NULL" : ""
            } ORDER BY ${key} LIMIT ?)`,
            take,
          );
        }
        this.compact();
      }
      this.compact();
      this.db!.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    });
  }

  /** Releases space that deletes freed. FTS5 keeps deleted rows as tombstones until a merge. */
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
