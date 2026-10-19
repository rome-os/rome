// Wire types of the daemon's observation methods: node.status, log.query, log.stats, and the
// `node` event topic. The design record is rome-os/rome#1031.
import type { ConnectionStatus } from "./client.js";

export type Outcome = "ok" | "error" | "aborted" | "unknown_outcome" | "interrupted";
export const OUTCOMES: readonly Outcome[] = [
  "ok",
  "error",
  "aborted",
  "unknown_outcome",
  "interrupted",
];

/**
 * One action the daemon sent (`out`) or ran (`in`). `endedAt` and `outcome` stay null while the
 * action runs. `args` holds the exec argv, or the action arguments as JSON text for any other
 * action. Text beyond 16 Ki characters per row arrives cut, with `truncated` set.
 */
export interface ActionRow {
  id: number;
  direction: "in" | "out";
  peer: string | null;
  action: string;
  mode: "json" | "binary" | "copy";
  command: string | null;
  args: string[] | string | null;
  cwd: string | null;
  startedAt: number;
  endedAt: number | null;
  outcome: Outcome | null;
  errorCode: string | null;
  exitCode: number | null;
  signal: string | null;
  stdinBytes: number;
  stdoutBytes: number;
  stderrBytes: number;
  /** Set on copies only. `bytes` is the size the receiver verified. */
  transfer: {
    direction: "push" | "pull";
    localPath: string;
    remotePath: string;
    bytes: number | null;
    sha256: string | null;
  } | null;
  truncated?: true;
}

export interface RoleStatus {
  deviceId?: string;
  name?: string;
  auth: "required" | "authorized" | "revoked";
  connection: ConnectionStatus;
  /** Milliseconds since the epoch when `connection` last changed. */
  since: number;
  /** How many times the role came back online after its first connection. */
  reconnects: number;
  running: number;
}

export interface NodeStatus {
  version: string;
  startedAt: number;
  roles: { caller?: RoleStatus; host?: RoleStatus };
}

export type NodeEvent =
  | { type: "snapshot"; status: NodeStatus; running: ActionRow[] }
  | { type: "connection"; role: "caller" | "host"; status: ConnectionStatus; at: number }
  | { type: "action"; id: number; phase: "start" | "end"; row: ActionRow };

/**
 * What an action came to, for counting and filtering. `failed` covers an `error` outcome and a
 * program that exited non-zero or by a signal. `no_result` covers `unknown_outcome`, `aborted`,
 * and `interrupted`, where nothing reports how the program ended.
 */
export type ActionResult = "running" | "succeeded" | "failed" | "no_result";
export const ACTION_RESULTS: readonly ActionResult[] = [
  "running",
  "succeeded",
  "failed",
  "no_result",
];

/** Actions newest first. `before` pages to older ids. */
export interface LogQuery {
  kind: "actions";
  before?: number;
  limit?: number;
  direction?: "in" | "out";
  peer?: string;
  outcome?: Outcome[];
  result?: ActionResult[];
  /** Milliseconds since the epoch. Keeps actions that started at or after it. */
  since?: number;
  /** Milliseconds since the epoch. Keeps actions that started before it. */
  until?: number;
  /** Substring match over command, args, and cwd. Needs at least three characters. */
  text?: string;
}

/**
 * Counts of actions that started in `[since, until)`, in buckets of `bucketMs`. `until`
 * defaults to now. The range holds at most 1,000 buckets.
 */
export interface LogStatsQuery {
  since: number;
  until?: number;
  bucketMs: number;
  direction?: "in" | "out";
  peer?: string;
}

/** One count. `bucket` is the index from `since`. Empty buckets have no group. */
interface LogStatsGroup {
  peer: string | null;
  bucket: number;
  result: ActionResult;
  count: number;
}

export interface LogStats {
  since: number;
  until: number;
  bucketMs: number;
  groups: LogStatsGroup[];
}

/** `hasMore` means the page stopped at its row or byte limit. */
export interface LogResult<T> {
  rows: T[];
  hasMore: boolean;
}
