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

/** Whether `text` ends with the first half of a surrogate pair, without the second. */
export function endsMidPair(text: string): boolean {
  return text.length > 0 && isHighSurrogate(text.charCodeAt(text.length - 1));
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

/** A code fence, and what a line that closes it must repeat. A fence counts
 *  at any indent, since a list item indents the code it holds. */
const FENCE = /^[ \t]*(`{3,}|~{3,})/;
/** An opening code fence, which may also follow a list item's markers. */
const OPENING_FENCE = /^[ \t]*(?:(?:[-*+]|\d{1,9}[.)])[ \t]+)*(`{3,}|~{3,})/;

/**
 * The offset in `text` where a message that starts at `from` should end so it
 * holds whole paragraphs: the start of the first paragraph that begins once
 * the message measures at least `soft`, at most `to`, and at or after `min`
 * unless only whitespace lies between it and `min`.
 * Answers 0 when no such paragraph has begun yet. A blank line inside fenced
 * code is no paragraph break, so code stays in one message.
 *
 * It reads only the text that has arrived, and a paragraph counts once its
 * first visible character has, so the answer is the same while the text
 * streams and once it is complete.
 *
 * Cost: one scan of `text` up to `to`, and O(log n) measures.
 */
export function paragraphEnd(
  text: string,
  from: number,
  to: number,
  min: number,
  soft: number,
  measure: (end: number) => number,
): number {
  const starts: number[] = [];
  let fence: { char: string; length: number } | undefined;
  let blank = false;
  let offset = 0;
  for (const line of text.slice(0, to).split("\n")) {
    const at = offset;
    offset += line.length + 1;
    if (fence) {
      const closing = FENCE.exec(line);
      if (
        closing &&
        closing[1]![0] === fence.char &&
        closing[1]!.length >= fence.length &&
        !line.slice(closing[0].length).trim()
      )
        fence = undefined;
      continue;
    }
    if (!line.trim()) {
      blank = true;
      continue;
    }
    // A message may already show the indent a paragraph starts with, which
    // shows nothing, so the paragraph still counts from the start of its line.
    if (blank && at > from && (at >= min || !text.slice(at, min).trim()) && at < to)
      starts.push(at);
    blank = false;
    const opening = OPENING_FENCE.exec(line);
    if (opening) fence = { char: opening[1]![0]!, length: opening[1]!.length };
  }
  // The first paragraph start whose message reaches `soft`.
  let low = 0;
  let high = starts.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (measure(starts[middle]!) >= soft) high = middle;
    else low = middle + 1;
  }
  return starts[low] ?? 0;
}
