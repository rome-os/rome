// Wire types of the daemon's observation methods: node.status, log.query, and the `node` event
// topic. The design record is rome-os/rome#1031.
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

/** Actions newest first. `before` pages to older ids. */
export interface LogQuery {
  kind: "actions";
  before?: number;
  limit?: number;
  direction?: "in" | "out";
  peer?: string;
  outcome?: Outcome[];
  /** Substring match over command, args, and cwd. Needs at least three characters. */
  text?: string;
}

/** `hasMore` means the page stopped at its row or byte limit. */
export interface LogResult<T> {
  rows: T[];
  hasMore: boolean;
}
