// Wire contract of a rome-node console socket. The socket carries the local daemon's JSON-RPC
// observation methods unchanged. Their source of truth is
// packages/rome-node-core/src/observe-protocol.ts, and this file validates the same shapes in
// the browser. Design record: rome-os/rome#1031.
import { z } from "zod";

const nodeConnectionStatusSchema = z.enum([
  "stopped",
  "connecting",
  "online",
  "retrying",
  "revoked",
  "superseded",
]);
export type NodeConnectionStatus = z.infer<typeof nodeConnectionStatusSchema>;

const nodeOutcomeSchema = z.enum(["ok", "error", "aborted", "unknown_outcome", "interrupted"]);
type NodeOutcome = z.infer<typeof nodeOutcomeSchema>;

export const nodeActionRowSchema = z.object({
  id: z.number(),
  direction: z.enum(["in", "out"]),
  peer: z.string().nullable(),
  action: z.string(),
  mode: z.enum(["json", "binary", "copy"]),
  command: z.string().nullable(),
  args: z.union([z.array(z.string()), z.string()]).nullable(),
  cwd: z.string().nullable(),
  startedAt: z.number(),
  endedAt: z.number().nullable(),
  outcome: nodeOutcomeSchema.nullable(),
  errorCode: z.string().nullable(),
  exitCode: z.number().nullable(),
  signal: z.string().nullable(),
  stdinBytes: z.number(),
  stdoutBytes: z.number(),
  stderrBytes: z.number(),
  transfer: z
    .object({
      direction: z.enum(["push", "pull"]),
      localPath: z.string(),
      remotePath: z.string(),
      bytes: z.number().nullable(),
      sha256: z.string().nullable(),
    })
    .nullable(),
  truncated: z.literal(true).optional(),
});
export type NodeActionRow = z.infer<typeof nodeActionRowSchema>;

const nodeRoleStatusSchema = z.object({
  deviceId: z.string().optional(),
  name: z.string().optional(),
  auth: z.enum(["required", "authorized", "revoked"]),
  connection: nodeConnectionStatusSchema,
  since: z.number(),
  reconnects: z.number(),
  running: z.number(),
});

export const nodeStatusSchema = z.object({
  version: z.string(),
  startedAt: z.number(),
  roles: z.object({
    caller: nodeRoleStatusSchema.optional(),
    host: nodeRoleStatusSchema.optional(),
  }),
});
export type NodeStatus = z.infer<typeof nodeStatusSchema>;

export const nodeEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("snapshot"),
    status: nodeStatusSchema,
    running: z.array(nodeActionRowSchema),
  }),
  z.object({
    type: z.literal("connection"),
    role: z.enum(["caller", "host"]),
    status: nodeConnectionStatusSchema,
    at: z.number(),
  }),
  z.object({
    type: z.literal("action"),
    id: z.number(),
    phase: z.enum(["start", "end"]),
    row: nodeActionRowSchema,
  }),
]);
export type NodeEvent = z.infer<typeof nodeEventSchema>;

/** Sent by the backend right before it closes the socket for lack of a daemon. */
export const nodeConsoleDaemonStateSchema = z.enum([
  "not_configured",
  "not_running",
  "incompatible",
  "disconnected",
]);
export type NodeConsoleDaemonState = z.infer<typeof nodeConsoleDaemonStateSchema>;

export function nodeLogResultSchema<T extends z.ZodType>(row: T) {
  return z.object({ rows: z.array(row), hasMore: z.boolean() });
}

const nodeActionResultSchema = z.enum(["running", "succeeded", "failed", "no_result"]);
/** What an action came to. The daemon defines it, and `resultOf` mirrors it for one row. */
export type NodeActionResult = z.infer<typeof nodeActionResultSchema>;

export type NodeActionQuery = {
  kind: "actions";
  before?: number;
  limit?: number;
  direction?: "in" | "out";
  peer?: string;
  outcome?: NodeOutcome[];
  result?: NodeActionResult[];
  since?: number;
  until?: number;
  text?: string;
};

export type NodeStatsQuery = {
  since: number;
  until?: number;
  bucketMs: number;
  direction?: "in" | "out";
  peer?: string;
};

export const nodeStatsSchema = z.object({
  since: z.number(),
  until: z.number(),
  bucketMs: z.number(),
  groups: z.array(
    z.object({
      peer: z.string().nullable(),
      bucket: z.number(),
      result: nodeActionResultSchema,
      count: z.number(),
    }),
  ),
});
export type NodeStats = z.infer<typeof nodeStatsSchema>;
