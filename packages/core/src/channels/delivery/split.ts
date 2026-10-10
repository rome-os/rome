import type { TextCodec } from "./types.js";

// Breaks a reader can follow, best first. A part ends just after one.
const BREAKS = [/\n\n/g, /\n/g, /[.!?。！？](?=\s|$)|[。！？]/g, /\s/g];

// The same for text that is still growing. Its end is only where the stream
// has got to, so a full stop there may be a decimal point or a domain's dot.
// A full stop is a sentence end once whitespace follows it.
const GROWING_BREAKS = [/\n\n/g, /\n/g, /[.!?](?=\s)|[。！？]/g, /\s/g];

/**
 * The offset just after the last readable break in `source`, which is text
 * that may still grow, or 0 when it has none. A stronger break wins when one
 * lies in the second half, as in `splitPoint`, and otherwise the latest break
 * of any kind does.
 */
export function lastBreak(source: string): number {
  const floor = Math.ceil(source.length / 2);
  let latest = 0;
  for (const pattern of GROWING_BREAKS) {
    let found = 0;
    for (const match of source.matchAll(pattern)) found = match.index + match[0].length;
    if (found > 0 && found >= floor) return found;
    latest = Math.max(latest, found);
  }
  return latest;
}

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

  // Breaks are found in all of `source`, so a full stop at the cut counts only
  // when whitespace follows it there, and not when more of a number does.
  const floor = Math.ceil(low / 2);
  for (const pattern of BREAKS) {
    let found = -1;
    for (const match of source.matchAll(pattern)) {
      const end = match.index + match[0].length;
      if (end > low) break;
      if (end >= floor) found = end;
    }
    if (found > 0) return found;
  }
  return low;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/** Whether a cut at `at` would separate the two halves of a surrogate pair. */
export function splitsPair(text: string, at: number): boolean {
  return (
    at > 0 &&
    at < text.length &&
    isHighSurrogate(text.charCodeAt(at - 1)) &&
    isLowSurrogate(text.charCodeAt(at))
  );
}
