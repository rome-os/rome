// Splits one sentence that is too long for a single speech stream. Soniox takes
// at most 5000 characters in a message and ends a stream after 2 minutes of
// audio, so the parts keep under both, the audio by an estimate of how long
// the text takes to say.

export interface SplitLimits {
  /** Most characters in one part. */
  maxChars: number;
  /** Most estimated seconds of audio in one part. */
  maxSeconds: number;
}

export const DEFAULT_SPLIT_LIMITS: SplitLimits = {
  maxChars: 5000,
  // The provider's hard stop is 120 s, and the estimate is rough.
  maxSeconds: 100,
};

// Seconds to say one character, rounded up from ordinary speech: about 4
// Chinese characters a second, and about 14 Latin letters a second.
const SECONDS_PER_CJK = 0.28;
const SECONDS_PER_OTHER = 0.075;

// CJK radicals through ideographs, Hangul, compatibility ideographs, full-width forms.
const CJK = /[⺀-鿿가-힯豈-﫿＀-￯]/u;
const SENTENCE_END = /[。！？!?；;\n]/u;
const CLAUSE_END = /[，、：,:]/u;

const secondsFor = (char: string): number => (CJK.test(char) ? SECONDS_PER_CJK : SECONDS_PER_OTHER);

/** The parts of `text`, in order, each within `limits`. Text that fits comes back whole, trimmed. */
export function splitForStreams(
  text: string,
  limits: SplitLimits = DEFAULT_SPLIT_LIMITS,
): string[] {
  const chars = Array.from(text.trim());
  const parts: string[] = [];
  let start = 0;
  while (start < chars.length) {
    let end = start;
    let units = 0;
    let seconds = 0;
    // The latest place a part may end at, by how natural the break is.
    let sentence = -1;
    let clause = -1;
    let space = -1;
    while (end < chars.length) {
      const char = chars[end] as string;
      if (units + char.length > limits.maxChars || seconds + secondsFor(char) > limits.maxSeconds)
        break;
      units += char.length;
      seconds += secondsFor(char);
      end++;
      if (SENTENCE_END.test(char)) sentence = end;
      else if (CLAUSE_END.test(char)) clause = end;
      else if (/\s/u.test(char)) space = end;
    }
    let cut = end;
    if (end < chars.length) {
      // A break in the first half of the room would leave a short part and a
      // long one after it, so it only counts from the middle on.
      const middle = start + (end - start) / 2;
      for (const candidate of [sentence, clause, space]) {
        if (candidate > middle) {
          cut = candidate;
          break;
        }
      }
    }
    // A single character over the limits cannot happen with sane limits, but never loop on it.
    if (cut === start) cut = start + 1;
    const part = chars.slice(start, cut).join("").trim();
    if (part) parts.push(part);
    start = cut;
  }
  return parts;
}
