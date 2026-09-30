// Minimal pbbp2.Frame wire codec for the official SDK's WebSocket protocol.
// Only varint and length-delimited fields used by this fixture are supported.
interface Frame {
  sequence: number;
  method: number;
  headers: Record<string, string>;
  payload: Uint8Array;
}
function varint(value: number): Buffer {
  const bytes: number[] = [];
  do {
    const part = value % 128;
    value = Math.floor(value / 128);
    bytes.push(part | (value ? 128 : 0));
  } while (value);
  return Buffer.from(bytes);
}
function bytes(field: number, value: Uint8Array) {
  return Buffer.concat([varint(field * 8 + 2), varint(value.length), value]);
}
export function encodeLarkFrame(frame: Frame): Buffer {
  const headers = Object.entries(frame.headers).map(([key, value]) =>
    bytes(5, Buffer.concat([bytes(1, Buffer.from(key)), bytes(2, Buffer.from(value))])),
  );
  return Buffer.concat([
    Buffer.from([8]),
    varint(frame.sequence),
    Buffer.from([16, 0, 24, 1, 32]),
    varint(frame.method),
    ...headers,
    bytes(8, frame.payload),
  ]);
}
function fields(input: Uint8Array): Map<number, Array<number | Buffer>> {
  const result = new Map<number, Array<number | Buffer>>();
  let cursor = 0;
  const read = () => {
    let value = 0;
    let multiplier = 1;
    for (let i = 0; i < 8; i++) {
      if (cursor >= input.length) throw new Error("Truncated Lark frame");
      const byte = input[cursor++];
      value += (byte & 127) * multiplier;
      if (!(byte & 128)) return value;
      multiplier *= 128;
    }
    throw new Error("Unsupported Lark varint");
  };
  while (cursor < input.length) {
    const tag = read();
    const field = Math.floor(tag / 8);
    const wire = tag % 8;
    let value: number | Buffer;
    if (wire === 0) value = read();
    else if (wire === 2) {
      const length = read();
      if (cursor + length > input.length) throw new Error("Truncated Lark field");
      value = Buffer.from(input.subarray(cursor, cursor + length));
      cursor += length;
    } else throw new Error(`Unsupported Lark wire type ${wire}`);
    result.set(field, [...(result.get(field) ?? []), value]);
  }
  return result;
}
export function decodeLarkFrame(input: Uint8Array): Frame {
  const values = fields(input);
  const headers: Record<string, string> = {};
  for (const header of values.get(5) ?? []) {
    if (!Buffer.isBuffer(header)) throw new Error("Invalid Lark header");
    const pair = fields(header);
    headers[String(pair.get(1)?.[0])] = String(pair.get(2)?.[0]);
  }
  return {
    sequence: Number(values.get(1)?.[0] ?? 0),
    method: Number(values.get(4)?.[0] ?? 0),
    headers,
    payload: (values.get(8)?.[0] as Buffer) ?? Buffer.alloc(0),
  };
}
