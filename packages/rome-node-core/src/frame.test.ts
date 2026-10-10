import { describe, expect, it } from "@rstest/core";
import { randomUUID } from "node:crypto";
import {
  decodeMeta,
  encodeFrame,
  encodeMeta,
  FRAME_HEADER_BYTES,
  FRAME_TYPE,
  parseFrame,
  uuidBytes,
  uuidString,
} from "./frame.js";

const id = "0f8fad5b-d9cb-469f-a165-70867728950e";
const peer = "7c9e6679-7425-40de-944b-e07fc1f90ae7";

describe("binary frame codec", () => {
  it("round-trips UUIDs as 16 raw bytes and normalizes case", () => {
    expect(Array.from(uuidBytes(id).slice(0, 4))).toEqual([0x0f, 0x8f, 0xad, 0x5b]);
    expect(uuidBytes(id)).toHaveLength(16);
    expect(uuidString(uuidBytes(id.toUpperCase()))).toBe(id);
    const random = randomUUID();
    expect(uuidString(uuidBytes(random))).toBe(random);
    expect(() => uuidBytes("caller")).toThrow(TypeError);
  });

  it("round-trips a frame with binary meta and body without copying on parse", () => {
    const body = Uint8Array.from([0x00, 0xff, 0x0a, 0x0d, 0x00, 0x80]);
    const meta = encodeMeta({ type: "request", action: "exec", args: { command: "cat" } });
    const bytes = encodeFrame({ type: FRAME_TYPE.request, id, peer, meta, body });
    expect(bytes.byteLength).toBe(FRAME_HEADER_BYTES + meta.byteLength + body.byteLength);
    expect(Array.from(bytes.subarray(0, 4))).toEqual([1, 1, 0, 0]);
    expect(new DataView(bytes.buffer).getUint32(36)).toBe(meta.byteLength);
    // Parse from an offset view, as ws delivers slices of pooled buffers.
    const pooled = new Uint8Array(bytes.byteLength + 7);
    pooled.set(bytes, 7);
    const frame = parseFrame(pooled.subarray(7));
    expect(frame).toMatchObject({ type: 1, id, peer });
    expect(Array.from(frame!.body)).toEqual(Array.from(body));
    expect(decodeMeta(frame!.meta)).toEqual({
      type: "request",
      action: "exec",
      args: { command: "cat" },
    });
    expect(frame!.body.buffer).toBe(pooled.buffer);
  });

  it("accepts empty meta and body and route error frames", () => {
    const frame = parseFrame(
      encodeFrame({
        type: FRAME_TYPE.routeError,
        id,
        peer,
        meta: new Uint8Array(),
        body: new Uint8Array(),
      }),
    );
    expect(frame).toMatchObject({ type: 3, id, peer });
    expect(frame!.meta.byteLength).toBe(0);
    expect(frame!.body.byteLength).toBe(0);
  });

  it("rejects truncated, versioned, flagged, unknown-type, and overlong-meta frames", () => {
    const valid = encodeFrame({
      type: FRAME_TYPE.response,
      id,
      peer,
      meta: encodeMeta({}),
      body: new Uint8Array(3),
    });
    const mutate = (change: (bytes: Uint8Array, view: DataView) => void) => {
      const copy = valid.slice();
      change(copy, new DataView(copy.buffer));
      return parseFrame(copy);
    };
    expect(parseFrame(valid.subarray(0, FRAME_HEADER_BYTES - 1))).toBeNull();
    expect(mutate((bytes) => (bytes[0] = 2))).toBeNull();
    expect(mutate((_bytes, view) => view.setUint16(2, 1))).toBeNull();
    expect(mutate((bytes) => (bytes[1] = 0))).toBeNull();
    expect(mutate((bytes) => (bytes[1] = 4))).toBeNull();
    expect(mutate((_bytes, view) => view.setUint32(36, valid.byteLength))).toBeNull();
    expect(parseFrame(valid)).not.toBeNull();
  });

  it("returns undefined for meta that is not UTF-8 JSON", () => {
    expect(decodeMeta(Uint8Array.from([0xff, 0xfe]))).toBeUndefined();
    expect(decodeMeta(new TextEncoder().encode("{"))).toBeUndefined();
  });
});
