import { describe, expect, it } from "@rstest/core";
import { encodeFrame, FrameDecoder } from "./frames.js";
import { type JsonObject, JSON_LIMIT, PNG_LIMIT } from "./protocol.js";

function header(jsonLength: number, binaryLength: number): Buffer {
  const bytes = Buffer.alloc(8);
  bytes.writeUInt32BE(jsonLength);
  bytes.writeUInt32BE(binaryLength, 4);
  return bytes;
}

function unvalidated(json: Buffer | string, binaryLength = 0): Buffer {
  const metadata = Buffer.from(json);
  return Buffer.concat([header(metadata.length, binaryLength), metadata]);
}

function image(width = 640, height = 480, bytes = 33) {
  const png = Buffer.alloc(Math.max(bytes, 33));
  Buffer.from("89504e470d0a1a0a0000000d49484452", "hex").copy(png);
  png.writeUInt32BE(width, 16);
  png.writeUInt32BE(height, 20);
  const message = {
    v: 1,
    id: "image",
    ok: true,
    result: { screenshot: { mimeType: "image/png", width, height, bytes } },
  };
  return { message, png };
}

function collector() {
  const frames: { message: JsonObject; binary: Buffer }[] = [];
  const decoder = new FrameDecoder((message) => (binary) => {
    frames.push({ message, binary });
  });
  return { frames, decoder };
}

describe("Computer Use frame codec", () => {
  it("uses big-endian byte lengths and round-trips metadata and raw PNGs", () => {
    const { decoder, frames } = collector();
    const status = { v: 1, id: "测试", method: "status" };
    const first = encodeFrame(status);
    const { message, png } = image();
    const second = encodeFrame(message, png);
    expect(first.readUInt32BE(0)).toBe(Buffer.byteLength(JSON.stringify(status)));
    expect(first.readUInt32BE(4)).toBe(0);
    expect(second.readUInt32BE(4)).toBe(png.length);
    decoder.push(first);
    expect(frames).toEqual([{ message: status, binary: Buffer.alloc(0) }]);
    decoder.push(Buffer.concat([second, first, second]));
    decoder.finish();
    expect(frames.slice(1)).toEqual([
      { message, binary: png },
      { message: status, binary: Buffer.alloc(0) },
      { message, binary: png },
    ]);
  });

  it("streams every byte independently through the header, JSON, and image", () => {
    const { decoder, frames } = collector();
    const { message, png } = image();
    const encoded = encodeFrame(message, png);
    for (let i = 0; i < encoded.length - 1; i++) decoder.push(encoded.subarray(i, i + 1));
    expect(frames).toEqual([]);
    decoder.push(encoded.subarray(-1));
    decoder.finish();
    expect(frames).toEqual([{ message, binary: png }]);
  });

  it.each([
    [0, 0],
    [JSON_LIMIT + 1, 0],
    [1, PNG_LIMIT + 1],
    [0xffffffff, 0xffffffff],
  ])("rejects an invalid header immediately (%i JSON, %i binary)", (json, binary) => {
    const { decoder } = collector();
    expect(() => decoder.push(header(json, binary))).toThrow("frame_limit");
    expect(() => decoder.push(encodeFrame({}))).toThrow("frame_limit");
  });

  it.each([
    "[1]",
    "null",
    "true",
    "42",
    '"hi"',
    "{",
    Buffer.from([0xff]),
  ])("rejects invalid UTF-8 and non-object JSON (%s)", (json) => {
    const { decoder } = collector();
    expect(() => decoder.push(unvalidated(json))).toThrow("invalid_frame");
  });

  it("enforces limits exactly and rejects truncated frames on EOF", () => {
    const { decoder, frames } = collector();
    const meta = encodeFrame({ text: "x".repeat(JSON_LIMIT - 11) });
    expect(meta.readUInt32BE(0)).toBe(JSON_LIMIT);
    const { message, png } = image(2048, 1536, PNG_LIMIT);
    decoder.push(meta);
    decoder.push(encodeFrame(message, png));
    expect(frames[1].binary.length).toBe(PNG_LIMIT);
    for (const part of [
      meta.subarray(0, 4),
      meta.subarray(0, 10),
      unvalidated(JSON.stringify(message), png.length),
    ]) {
      const partial = collector().decoder;
      partial.push(part);
      expect(() => partial.finish()).toThrow("invalid_frame");
    }
    expect(() => encodeFrame({ text: "x".repeat(JSON_LIMIT) })).toThrow("frame_limit");
  });

  it.each([
    { v: 1, id: "1", method: "observe", params: { screenshot: true } },
    { v: 1, id: "1", ok: false, error: { code: "capture_failed" } },
    { v: 1, id: "1", ok: true, result: { stop: "running" } },
  ])("rejects a binary payload as soon as non-image metadata arrives", (message) => {
    const { decoder } = collector();
    expect(() => decoder.push(unvalidated(JSON.stringify(message), 33))).toThrow("invalid_frame");
    expect(() => encodeFrame(message, Buffer.alloc(33))).toThrow("invalid_frame");
  });

  it("rejects descriptor byte counts, dimensions, pixel area, and PNG header mismatches", () => {
    for (const { message, png } of [
      image(2049, 1),
      image(1, 2049),
      image(2048, 1537),
      image(0, 1),
      image(1, 1, 32),
    ]) {
      const { decoder } = collector();
      expect(() => decoder.push(unvalidated(JSON.stringify(message), png.length))).toThrow(
        "invalid_frame",
      );
    }
    const { message, png } = image();
    const meta = JSON.stringify(message);
    expect(() => collector().decoder.push(unvalidated(meta, png.length + 1))).toThrow(
      "invalid_frame",
    );
    for (const offset of [0, 11, 12, 19, 23]) {
      const malformed = Buffer.from(png);
      malformed[offset] ^= 0xff;
      const { decoder } = collector();
      decoder.push(unvalidated(meta, malformed.length));
      expect(() => decoder.push(malformed)).toThrow("invalid_frame");
    }
  });
});
