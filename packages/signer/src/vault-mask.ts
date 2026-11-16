// Streaming output masker for `vault load`. It replaces every exact occurrence
// of a secret's value with `[vault:NAME]`, including a value split across two
// chunks. It works on bytes, so multi-byte UTF-8 values match too.

export interface MaskSecret {
  name: string;
  value: string;
}

export interface Masker {
  /** Takes the next chunk and returns the bytes that are safe to print now. */
  write(chunk: Buffer): Buffer;
  /** Returns the held-back tail once the stream has ended. */
  end(): Buffer;
}

/**
 * Longer values win over shorter ones that start at the same position. The
 * masker holds back the last `longest - 1` bytes of each chunk, because a
 * value may start there and finish in the next chunk. Empty values are ignored.
 */
export function createMasker(secrets: MaskSecret[]): Masker {
  const needles = secrets
    .filter((secret) => secret.value.length > 0)
    .map((secret) => ({
      bytes: Buffer.from(secret.value, "utf8"),
      token: Buffer.from(`[vault:${secret.name}]`, "utf8"),
    }))
    .sort((a, b) => b.bytes.length - a.bytes.length);
  const longest = needles[0]?.bytes.length ?? 0;
  let pending: Buffer = Buffer.alloc(0);

  /** Masks the start positions below `limit`; returns the output and where scanning stopped. */
  const scan = (data: Buffer, limit: number): { out: Buffer; stoppedAt: number } => {
    const parts: Buffer[] = [];
    let copiedTo = 0;
    let i = 0;
    while (i < limit) {
      const hit = needles.find(
        (needle) =>
          data[i] === needle.bytes[0] &&
          needle.bytes.length <= data.length - i &&
          data.compare(needle.bytes, 0, needle.bytes.length, i, i + needle.bytes.length) === 0,
      );
      if (hit) {
        parts.push(data.subarray(copiedTo, i), hit.token);
        i += hit.bytes.length;
        copiedTo = i;
      } else {
        i++;
      }
    }
    parts.push(data.subarray(copiedTo, i));
    return { out: Buffer.concat(parts), stoppedAt: i };
  };

  return {
    write(chunk) {
      if (longest === 0) return chunk;
      const data = Buffer.concat([pending, chunk]);
      // A start position is decided once `longest` bytes follow it.
      const { out, stoppedAt } = scan(data, data.length - longest + 1);
      pending = Buffer.from(data.subarray(stoppedAt));
      return out;
    },
    end() {
      const data = pending;
      pending = Buffer.alloc(0);
      return scan(data, data.length).out;
    },
  };
}
