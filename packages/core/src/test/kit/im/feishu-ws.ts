// Feishu's long-connection frames, as `pbbp2.Frame` in the SDK's WSClient
// spells them on the wire: a protobuf message with the frame's sequence and
// log ids, its service and method (0 control, 1 data), string headers, and a
// payload. Written by hand so the peer needs no protobuf runtime of its own.

export const FRAME_CONTROL = 0;
export const FRAME_DATA = 1;

export interface Frame {
  seqId: number;
  logId: number;
  service: number;
  method: number;
  headers: Record<string, string>;
  payload?: Uint8Array;
}

export function encodeFrame(frame: Frame): Uint8Array {
  const out: number[] = [];
  const varint = (value: number) => {
    let v = BigInt(value);
    do {
      let byte = Number(v & 0x7fn);
      v >>= 7n;
      if (v > 0n) byte |= 0x80;
      out.push(byte);
    } while (v > 0n);
  };
  const bytes = (field: number, data: Uint8Array) => {
    varint((field << 3) | 2);
    varint(data.length);
    out.push(...data);
  };
  const text = (value: string) => new TextEncoder().encode(value);
  varint((1 << 3) | 0);
  varint(frame.seqId);
  varint((2 << 3) | 0);
  varint(frame.logId);
  varint((3 << 3) | 0);
  varint(frame.service);
  varint((4 << 3) | 0);
  varint(frame.method);
  for (const [key, value] of Object.entries(frame.headers)) {
    const header: number[] = [];
    const k = text(key);
    const v = text(value);
    header.push(0x0a, ...lengthOf(k.length), ...k, 0x12, ...lengthOf(v.length), ...v);
    bytes(5, Uint8Array.from(header));
  }
  if (frame.payload) bytes(8, frame.payload);
  return Uint8Array.from(out);
}

function lengthOf(n: number): number[] {
  const out: number[] = [];
  let v = n;
  do {
    let byte = v & 0x7f;
    v >>>= 7;
    if (v > 0) byte |= 0x80;
    out.push(byte);
  } while (v > 0);
  return out;
}

export function decodeFrame(buffer: Uint8Array): Frame {
  const frame: Frame = { seqId: 0, logId: 0, service: 0, method: 0, headers: {} };
  let at = 0;
  const varint = (): bigint => {
    let result = 0n;
    let shift = 0n;
    for (;;) {
      const byte = buffer[at++]!;
      result |= BigInt(byte & 0x7f) << shift;
      if (!(byte & 0x80)) return result;
      shift += 7n;
    }
  };
  const chunk = (): Uint8Array => {
    const length = Number(varint());
    const data = buffer.subarray(at, at + length);
    at += length;
    return data;
  };
  while (at < buffer.length) {
    const tag = Number(varint());
    const field = tag >> 3;
    const wire = tag & 7;
    if (wire === 0) {
      const value = Number(varint());
      if (field === 1) frame.seqId = value;
      else if (field === 2) frame.logId = value;
      else if (field === 3) frame.service = value;
      else if (field === 4) frame.method = value;
      continue;
    }
    if (wire !== 2) throw new Error(`Unexpected wire type ${wire} in a Feishu frame`);
    const data = chunk();
    if (field === 5) {
      const header = decodeFrameHeader(data);
      frame.headers[header.key] = header.value;
    } else if (field === 8) frame.payload = data;
  }
  return frame;
}

function decodeFrameHeader(buffer: Uint8Array): { key: string; value: string } {
  let at = 0;
  let key = "";
  let value = "";
  while (at < buffer.length) {
    const tag = buffer[at++]!;
    let length = 0;
    let shift = 0;
    for (;;) {
      const byte = buffer[at++]!;
      length |= (byte & 0x7f) << shift;
      if (!(byte & 0x80)) break;
      shift += 7;
    }
    const data = new TextDecoder().decode(buffer.subarray(at, at + length));
    at += length;
    if (tag >> 3 === 1) key = data;
    else if (tag >> 3 === 2) value = data;
  }
  return { key, value };
}
