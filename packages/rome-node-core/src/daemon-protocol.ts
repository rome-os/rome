import { isRecord } from "./actions.js";
import type { ConnectionStatus } from "./client.js";

export const DAEMON_PROTOCOL_VERSION = 3;
/** Both local ends close the socket with 1009 when one message exceeds this many bytes. */
export const MAX_LOCAL_MESSAGE_BYTES = 64 * 1024 * 1024;

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

/**
 * Encodes one binary local message: a u32 big-endian JSON length, the JSON-RPC message as
 * UTF-8, then the raw body. Throws when `message` is not JSON.
 */
export function encodeBinaryMessage(message: unknown, body: Uint8Array): Buffer {
  const json = Buffer.from(JSON.stringify(message));
  const header = Buffer.alloc(4);
  header.writeUInt32BE(json.byteLength);
  return Buffer.concat([header, json, body]);
}

/** Returns null for a malformed message. The body is a view into `data`. */
export function parseBinaryMessage(data: Buffer): { message: unknown; body: Uint8Array } | null {
  if (data.byteLength < 4) return null;
  const end = 4 + data.readUInt32BE(0);
  if (end > data.byteLength) return null;
  try {
    const message: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(data.subarray(4, end)),
    );
    return { message, body: data.subarray(end) };
  } catch {
    return null;
  }
}

/** One copy between a local file on the caller and a file on a device. */
export interface CopyRequest {
  /** push copies localPath to the device, pull copies remotePath from it. */
  direction: "push" | "pull";
  /** Absolute path on the computer that runs the caller daemon. */
  localPath: string;
  deviceId: string;
  /** Path on the device. A relative path starts from the host process working directory. */
  remotePath: string;
}

export interface CopySummary {
  bytes: number;
  ms: number;
  /** Lowercase hex SHA-256 of the copied bytes, checked by both sides. */
  sha256: string;
}

/** Bytes written by the receiver so far, out of total. */
export interface CopyProgress {
  bytes: number;
  total: number;
}
