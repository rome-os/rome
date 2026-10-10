// Binary Gateway frames. Layout and relay rules: docs/rome-node.md#binary-frames.
export const FRAME_VERSION = 1;
export const FRAME_TYPE = { request: 1, response: 2, routeError: 3 } as const;
export type FrameType = (typeof FRAME_TYPE)[keyof typeof FRAME_TYPE];
export const FRAME_HEADER_BYTES = 40;
/**
 * Largest encoded frame, header and meta included. Cloudflare closes a Gateway socket that
 * receives a larger message, which drops every request on that connection.
 */
export const MAX_FRAME_BYTES = 32 * 1024 * 1024;

/** Returns whether a frame with this meta and body stays within MAX_FRAME_BYTES. */
export function frameFits(metaBytes: number, bodyBytes: number): boolean {
  return FRAME_HEADER_BYTES + metaBytes + bodyBytes <= MAX_FRAME_BYTES;
}
const PEER_OFFSET = 20;
const META_LENGTH_OFFSET = 36;

export interface Frame {
  type: FrameType;
  /** Request ID as a lowercase UUID. */
  id: string;
  /** Recipient when sent by a client, sender when received from the Gateway. Lowercase UUID. */
  peer: string;
  meta: Uint8Array;
  body: Uint8Array;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

/** Throws TypeError unless `id` is a UUID. Case is not significant. */
export function uuidBytes(id: string): Uint8Array {
  if (!UUID.test(id)) throw new TypeError("UUID required");
  return Buffer.from(id.replaceAll("-", ""), "hex");
}

/** Returns the lowercase UUID for 16 bytes. */
export function uuidString(bytes: Uint8Array): string {
  const hex = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** Returns null for a malformed frame. Meta and body are views into `data`, not copies. */
export function parseFrame(data: Uint8Array): Frame | null {
  if (data.byteLength < FRAME_HEADER_BYTES) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const type = view.getUint8(1);
  const metaEnd = FRAME_HEADER_BYTES + view.getUint32(META_LENGTH_OFFSET);
  if (view.getUint8(0) !== FRAME_VERSION || view.getUint16(2) !== 0) return null;
  if (type < FRAME_TYPE.request || type > FRAME_TYPE.routeError || metaEnd > data.byteLength)
    return null;
  return {
    type: type as FrameType,
    id: uuidString(data.subarray(4, PEER_OFFSET)),
    peer: uuidString(data.subarray(PEER_OFFSET, META_LENGTH_OFFSET)),
    meta: data.subarray(FRAME_HEADER_BYTES, metaEnd),
    body: data.subarray(metaEnd),
  };
}

/** Throws TypeError unless `id` and `peer` are UUIDs. Copies meta and body into one buffer. */
export function encodeFrame(frame: Frame): Uint8Array {
  const metaEnd = FRAME_HEADER_BYTES + frame.meta.byteLength;
  const bytes = new Uint8Array(metaEnd + frame.body.byteLength);
  const view = new DataView(bytes.buffer);
  view.setUint8(0, FRAME_VERSION);
  view.setUint8(1, frame.type);
  view.setUint32(META_LENGTH_OFFSET, frame.meta.byteLength);
  bytes.set(uuidBytes(frame.id), 4);
  bytes.set(uuidBytes(frame.peer), PEER_OFFSET);
  bytes.set(frame.meta, FRAME_HEADER_BYTES);
  bytes.set(frame.body, metaEnd);
  return bytes;
}

export function encodeMeta(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

/** Returns undefined when meta is not UTF-8 JSON. */
export function decodeMeta(meta: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(meta));
  } catch {
    return undefined;
  }
}
