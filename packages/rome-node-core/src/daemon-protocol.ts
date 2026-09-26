import { isRecord } from "./actions.js";
import type { ConnectionStatus } from "./client.js";

export const DAEMON_PROTOCOL_VERSION = 2;

export interface DaemonStatus {
  pid: number;
  protocolVersion: number;
  connection: ConnectionStatus;
}

export function parseDaemonStatus(value: unknown): DaemonStatus | null {
  if (
    !isRecord(value) ||
    !Number.isSafeInteger(value.pid) ||
    Number(value.pid) <= 0 ||
    typeof value.protocolVersion !== "number" ||
    !["stopped", "connecting", "online", "retrying", "revoked", "superseded"].includes(
      String(value.connection),
    )
  )
    return null;
  return {
    pid: value.pid as number,
    protocolVersion: value.protocolVersion,
    connection: value.connection as ConnectionStatus,
  };
}

export type ConnectionEvent =
  | { transport: "connected"; daemon: DaemonStatus }
  | { transport: "disconnected"; daemon: null; reason: "connection_lost" | "incompatible" };
