import type { TextCodec } from "./types.js";

// Breaks a reader can follow, best first. A part ends just after one.
const BREAKS = [/\n\n/g, /\n/g, /[.!?。！？](?=\s|$)|[。！？]/g, /\s/g];

/**
 * Where a message holding the start of `source` should end, as a source
 * offset: the longest prefix whose rendering fits `limit` both as a preview
 * and settled, moved back to a readable break when one lies in its second
 * half. Answers `source.length` when everything fits, and never splits a
 * surrogate pair. Throws when not even one character fits.
 *
 * Cost: O(log n) renders of at most `source.length` characters, so a codec
 * that scans its input keeps a part's split at O(n log n).
 */
export function splitPoint(source: string, limit: number, codec: TextCodec): number {
  const fits = (end: number) => {
    const prefix = source.slice(0, end);
    return (
      codec.measure(codec.render(prefix, true)) <= limit &&
      codec.measure(codec.render(prefix, false)) <= limit
    );
  };
  if (fits(source.length)) return source.length;

  // The largest fitting prefix: fits(low) holds and fits(high) does not.
  let low = 0;
  let high = source.length;
  while (high - low > 1) {
    const middle = (low + high) >>> 1;
    if (fits(middle)) low = middle;
    else high = middle;
  }
  if (low > 0 && isLowSurrogate(source.charCodeAt(low))) low -= 1;
  if (low === 0) throw new Error("Not even one character fits in a message");

  const floor = Math.ceil(low / 2);
  for (const pattern of BREAKS) {
    let found = -1;
    for (const match of source.slice(0, low).matchAll(pattern)) {
      const end = match.index + match[0].length;
      if (end >= floor) found = end;
    }
    if (found > 0) return found;
  }
  return low;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}
